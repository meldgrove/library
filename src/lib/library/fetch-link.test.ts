import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchLink, isPrivateAddress, LinkError } from "./fetch-link";

describe("isPrivateAddress", () => {
  it("refuses loopback, private, link-local, and mapped addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0", "not-an-ip"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const address of ["1.1.1.1", "142.250.185.78", "2a00:1450:4001:82a::200e", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe("fetchLink", () => {
  let server: Server;
  let other: Server;
  let base: string;
  let otherBase: string;

  const echo = (request: { headers: Record<string, string | string[] | undefined> }, response: import("node:http").ServerResponse) =>
    response.writeHead(200, { "content-type": "text/plain" }).end(String(request.headers.authorization ?? "none"));

  beforeAll(async () => {
    other = createServer((request, response) => echo(request, response));
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    server = createServer((request, response) => {
      if (request.url === "/echo") {
        echo(request, response);
      } else if (request.url === "/same") {
        response.writeHead(302, { location: "/echo" }).end();
      } else if (request.url === "/away") {
        response.writeHead(302, { location: `${otherBase}/echo` }).end();
      } else if (request.url === "/redirect") {
        response.writeHead(302, { location: "/page" }).end();
      } else if (request.url === "/loop") {
        response.writeHead(302, { location: "/loop" }).end();
      } else if (request.url === "/big") {
        response.writeHead(200, { "content-type": "application/pdf" });
        response.end(Buffer.alloc(2_000));
      } else if (request.url === "/trickle") {
        response.writeHead(200, { "content-type": "text/html" });
        const timer = setInterval(() => response.write("."), 50);
        response.on("close", () => clearInterval(timer));
      } else if (request.url === "/missing") {
        response.writeHead(404).end();
      } else {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<html><title>Page</title></html>");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => other.close(() => resolve()));
  });

  const allow = { maxBytes: 1_000, allowPrivateAddresses: true };

  it("refuses links into the local network", async () => {
    await expect(fetchLink(`${base}/page`, { maxBytes: 1_000 })).rejects.toThrow(LinkError);
    await expect(fetchLink("http://localhost:1/x", { maxBytes: 1_000 })).rejects.toThrow(/not on the public internet/);
  });

  it("follows redirects and returns the type without parameters", async () => {
    const result = await fetchLink(`${base}/redirect`, allow);
    expect(result).toMatchObject({ url: `${base}/page`, contentType: "text/html" });
    expect(Buffer.from(result.bytes).toString()).toContain("<title>Page</title>");
  });

  it("sends extra headers to the link's own origin only", async () => {
    const headers = { authorization: "Bearer xoxb-test" };
    const text = async (url: string) => Buffer.from((await fetchLink(url, { ...allow, headers })).bytes).toString();
    expect(await text(`${base}/echo`)).toBe("Bearer xoxb-test");
    expect(await text(`${base}/same`)).toBe("Bearer xoxb-test");
    expect(await text(`${base}/away`)).toBe("none");
  });

  it("gives up on a site that sends slowly, however long it keeps sending", async () => {
    await expect(fetchLink(`${base}/trickle`, { ...allow, maxBytes: 1_000_000, deadlineMs: 300 })).rejects.toThrow(/took too long/);
  });

  it("stops redirect loops, large files, errors, and other schemes", async () => {
    await expect(fetchLink(`${base}/loop`, allow)).rejects.toThrow(/redirects too often/);
    await expect(fetchLink(`${base}/big`, allow)).rejects.toThrow(/larger than/);
    await expect(fetchLink(`${base}/missing`, allow)).rejects.toThrow(/HTTP 404/);
    await expect(fetchLink("ftp://example.org/x", allow)).rejects.toThrow(/Only web links/);
  });
});
