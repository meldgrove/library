import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { release, status } from "../../../tests/fixtures/updates";

const config = vi.hoisted(() => ({ UPDATER_URL: null as string | null, APP_VERSION: "0.2.0" as string | undefined }));

vi.mock("@/lib/config", () => ({
  getUpdaterConfig: () => ({ UPDATER_URL: config.UPDATER_URL }),
  getVersionConfig: () => ({ APP_VERSION: config.APP_VERSION }),
}));

const { callUpdater, refuseWithStatus, UPDATER_TIMEOUTS, updaterCalls } = await import("./updater");

type Handler = (request: IncomingMessage, body: string, response: ServerResponse) => void;

let handler: Handler;
const requests: { method: string; url: string; body: string }[] = [];
let server: Server;
let baseUrl: string;

function json(response: ServerResponse, code: number, payload: unknown): void {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method!, url: request.url!, body });
    handler(request, body, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  requests.length = 0;
  config.UPDATER_URL = baseUrl;
  config.APP_VERSION = "0.2.0";
  handler = (_request, _body, response) => json(response, 200, status());
});

describe("callUpdater", () => {
  it("passes the updater's status on, with the library's version", async () => {
    const current = status({ available: release("0.2.1") });
    handler = (_request, _body, response) => json(response, 200, current);
    const result = await callUpdater(updaterCalls.status());
    expect(result).toEqual({ httpStatus: 200, body: { app: { version: "0.2.0" }, reachable: true, updater: current, error: null } });
    expect(requests).toEqual([{ method: "GET", url: "/v1/status", body: "" }]);
  });

  it("answers 202 when the updater accepted an installation", async () => {
    handler = (_request, _body, response) =>
      json(response, 202, status({ installing: { version: "0.2.1", startedAt: "2026-11-19T10:00:00.000Z", manual: true, stage: "requested" } }));
    const result = await callUpdater(updaterCalls.install("0.2.1"));
    expect(result.httpStatus).toBe(202);
    expect(result.body.updater?.installing?.version).toBe("0.2.1");
    expect(requests[0]).toEqual({ method: "POST", url: "/v1/install", body: JSON.stringify({ version: "0.2.1" }) });
  });

  it("turns an updater's refusal into 409 with its reason and the latest status", async () => {
    handler = (request, _body, response) =>
      request.url === "/v1/install" ? json(response, 409, { error: "0.9.9 is not offered; check again." }) : json(response, 200, status());
    const result = await callUpdater(updaterCalls.install("0.9.9"));
    expect(result).toEqual({
      httpStatus: 409,
      body: { app: { version: "0.2.0" }, reachable: true, updater: status(), error: "0.9.9 is not offered; check again." },
    });
    expect(requests.map((request) => request.url)).toEqual(["/v1/install", "/v1/status"]);
  });

  it("turns a server error of the updater into 409 as well", async () => {
    handler = (request, _body, response) =>
      request.url === "/v1/check" ? json(response, 500, { error: "The registry did not answer." }) : json(response, 200, status());
    const result = await callUpdater(updaterCalls.check());
    expect(result.httpStatus).toBe(409);
    expect(result.body.error).toBe("The registry did not answer.");
    expect(result.body.updater).toEqual(status());
  });

  it("answers reachable: false when nothing listens, as with updater 0.1", async () => {
    config.UPDATER_URL = "http://127.0.0.1:9";
    const result = await callUpdater(updaterCalls.status());
    expect(result.httpStatus).toBe(200);
    expect(result.body).toMatchObject({ app: { version: "0.2.0" }, reachable: false, updater: null });
    expect(result.body.error).toMatch(/not reachable/);
  });

  it("answers reachable: false when the updater does not answer in time", async () => {
    handler = () => {
      // Never answers.
    };
    const result = await callUpdater({ ...updaterCalls.status(), timeoutMs: 100 });
    expect(result).toMatchObject({ httpStatus: 200, body: { reachable: false, updater: null } });
    expect(result.body.error).toMatch(/did not answer within 0.1 seconds/);
  });

  it("answers reachable: false for a service that is not the updater", async () => {
    handler = (_request, _body, response) => {
      response.writeHead(404, { "content-type": "text/html" });
      response.end("<h1>Not found</h1>");
    };
    const result = await callUpdater(updaterCalls.status());
    expect(result.body).toMatchObject({ reachable: false, updater: null });
    expect(result.body.error).toMatch(/not Meldgrove Updater 0.2 or later/);
  });

  it("does not call anything when UPDATER_URL is empty", async () => {
    config.UPDATER_URL = null;
    config.APP_VERSION = undefined;
    const result = await callUpdater(updaterCalls.check());
    expect(result).toEqual({
      httpStatus: 200,
      body: { app: { version: null }, reachable: false, updater: null, error: "UPDATER_URL is empty, so the update service is off." },
    });
    expect(requests).toEqual([]);
  });
});

describe("refuseWithStatus", () => {
  it("answers the library's own refusal with the latest status", async () => {
    const result = await refuseWithStatus(400, "Name the version to install, such as 0.2.1.");
    expect(result).toEqual({ httpStatus: 400, body: { app: { version: "0.2.0" }, reachable: true, updater: status(), error: "Name the version to install, such as 0.2.1." } });
  });
});

describe("updaterCalls", () => {
  it("gives each call the time it may take", () => {
    expect(UPDATER_TIMEOUTS).toEqual({ status: 3_000, check: 35_000, install: 10_000, channel: 35_000 });
    expect(updaterCalls.status()).toMatchObject({ method: "GET", path: "/v1/status", timeoutMs: 3_000 });
    expect(updaterCalls.check()).toMatchObject({ method: "POST", path: "/v1/check", timeoutMs: 35_000 });
    expect(updaterCalls.install("0.2.1")).toMatchObject({ method: "POST", path: "/v1/install", body: { version: "0.2.1" }, timeoutMs: 10_000 });
    expect(updaterCalls.channel("preview")).toMatchObject({ method: "POST", path: "/v1/channel", body: { channel: "preview" }, timeoutMs: 35_000 });
  });
});
