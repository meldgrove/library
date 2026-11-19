import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { release, status } from "../../../../../tests/fixtures/updates";

const mocks = vi.hoisted(() => ({ getCurrentPerson: vi.fn(), updaterUrl: null as string | null }));

vi.mock("@/lib/auth/session", () => ({ getCurrentPerson: mocks.getCurrentPerson }));
vi.mock("@/lib/config", () => ({
  getAuthConfig: () => ({ LIBRARY_BASE_URL: "https://library.example" }),
  getUpdaterConfig: () => ({ UPDATER_URL: mocks.updaterUrl }),
  getVersionConfig: () => ({ APP_VERSION: "0.2.0" }),
}));

const routes = {
  status: await import("./route"),
  check: await import("./check/route"),
  install: await import("./install/route"),
  channel: await import("./channel/route"),
};

const ADMIN = { id: "00000000-0000-4000-8000-000000000001", isAdmin: true };
const MEMBER = { id: "00000000-0000-4000-8000-000000000002", isAdmin: false };

let handler: (request: IncomingMessage, body: string, response: ServerResponse) => void;
const calls: { method: string; url: string; body: string }[] = [];
let server: Server;

function json(response: ServerResponse, code: number, payload: unknown): void {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method!, url: request.url!, body });
    handler(request, body, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  mocks.getCurrentPerson.mockResolvedValue(ADMIN);
  mocks.updaterUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  handler = (_request, _body, response) => json(response, 200, status({ available: release("0.2.1") }));
});

function get(): Promise<Response> {
  return routes.status.GET(new Request("https://library.example/api/admin/updates"));
}

function post(route: "check" | "install" | "channel", body?: unknown, origin: string | null = "https://library.example"): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  return routes[route].POST(
    new Request(`https://library.example/api/admin/updates/${route}`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("/api/admin/updates", () => {
  it("answers 404 without a session and to people who are not admins", async () => {
    for (const person of [null, MEMBER]) {
      mocks.getCurrentPerson.mockResolvedValue(person);
      expect((await get()).status).toBe(404);
      expect((await post("check")).status).toBe(404);
      expect((await post("install", { version: "0.2.1" })).status).toBe(404);
      expect((await post("channel", { channel: "preview" })).status).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it("refuses POSTs from other sites and without an Origin", async () => {
    for (const origin of ["https://evil.example", null]) {
      const response = await post("install", { version: "0.2.1" }, origin);
      expect(response.status).toBe(403);
    }
    expect((await post("channel", { channel: "preview" }, "https://evil.example")).status).toBe(403);
    expect((await post("check", undefined, "https://evil.example")).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("answers the status for admins, without caching", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ app: { version: "0.2.0" }, reachable: true, updater: status({ available: release("0.2.1") }), error: null });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(["GET /v1/status"]);
  });

  it("checks on request", async () => {
    const response = await post("check");
    expect(response.status).toBe(200);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(["POST /v1/check"]);
  });

  it("installs a valid version and passes the 202 on", async () => {
    handler = (request, _body, response) =>
      json(response, request.url === "/v1/install" ? 202 : 200, status({ installing: { version: "0.2.1", startedAt: "2026-11-19T10:00:00.000Z", manual: true, stage: "requested" } }));
    for (const version of ["0.2.1", "0.3.0-preview.12", "sha256:0123456789ab"]) {
      const response = await post("install", { version });
      expect(response.status).toBe(202);
    }
    expect(calls.map((call) => call.body)).toEqual(['{"version":"0.2.1"}', '{"version":"0.3.0-preview.12"}', '{"version":"sha256:0123456789ab"}']);
  });

  it("refuses an invalid version before it calls the updater's install", async () => {
    for (const body of [{ version: "latest" }, { version: "0.2" }, { version: "0.2.1; rm -rf /" }, { version: "sha256:XYZ" }, {}, "not json"]) {
      const response = await post("install", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ reachable: true, error: "Name the version to install, such as 0.2.1." });
    }
    expect(calls.every((call) => call.url === "/v1/status")).toBe(true);
  });

  it("switches the channel and refuses unknown ones", async () => {
    expect((await post("channel", { channel: "preview" })).status).toBe(200);
    expect(calls.at(-1)).toEqual({ method: "POST", url: "/v1/channel", body: '{"channel":"preview"}' });
    calls.length = 0;
    const response = await post("channel", { channel: "nightly" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("The channel is stable or preview.");
    expect(calls.map((call) => call.url)).toEqual(["/v1/status"]);
  });

  it("answers 409 with the updater's reason when it refuses", async () => {
    const locked = "The platform's image tag latest decides which updates install. Change it there.";
    handler = (request, _body, response) =>
      request.url === "/v1/channel" ? json(response, 409, { error: locked }) : json(response, 200, status({ mode: "platform", channelLocked: locked }));
    const response = await post("channel", { channel: "preview" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      app: { version: "0.2.0" },
      reachable: true,
      updater: status({ mode: "platform", channelLocked: locked }),
      error: locked,
    });
  });

  it("passes a server error of the updater's install through, so that the browser looks for the installation", async () => {
    const busy = "The deploy link did not answer.";
    handler = (request, _body, response) => (request.url === "/v1/install" ? json(response, 503, { error: busy }) : json(response, 200, status({ available: release("0.2.1") })));
    const response = await post("install", { version: "0.2.1" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ app: { version: "0.2.0" }, reachable: true, updater: status({ available: release("0.2.1") }), error: busy });
    // A refusal of the install stays 409.
    handler = (request, _body, response) => (request.url === "/v1/install" ? json(response, 409, { error: "0.2.1 is not offered." }) : json(response, 200, status()));
    expect((await post("install", { version: "0.2.1" })).status).toBe(409);
  });

  it("answers reachable: false when no updater answers", async () => {
    mocks.updaterUrl = "http://127.0.0.1:9";
    for (const response of [await get(), await post("check"), await post("install", { version: "0.2.1" }), await post("channel", { channel: "stable" })]) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ app: { version: "0.2.0" }, reachable: false, updater: null });
    }
  });
});
