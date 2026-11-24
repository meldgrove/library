import { startFakeUpdater, updaterStatus, type FakeUpdater } from "@meldgrove/ui/updates/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The library's side of the update routes: who may ask, and that requests
 * reach the updater with UPDATER_TOKEN. How the answers look is
 * @meldgrove/ui/updates/server's, and tested there.
 */

const TOKEN = "updater-test-token";

const mocks = vi.hoisted(() => ({ getCurrentPerson: vi.fn(), updaterUrl: null as string | null, updaterToken: undefined as string | undefined }));

vi.mock("@/lib/auth/session", () => ({ getCurrentPerson: mocks.getCurrentPerson }));
vi.mock("@/lib/config", () => ({
  getAuthConfig: () => ({ LIBRARY_BASE_URL: "https://library.example" }),
  getUpdaterConfig: () => ({ UPDATER_URL: mocks.updaterUrl, UPDATER_TOKEN: mocks.updaterToken }),
  getVersionConfig: () => ({ APP_VERSION: "0.2.0" }),
}));

const routes = {
  status: await import("./route"),
  check: await import("./check/route"),
  install: await import("./install/route"),
  channel: await import("./channel/route"),
};

const ADMIN = { id: "00000000-0000-4000-8000-000000000001", role: "admin" };
const MEMBER = { id: "00000000-0000-4000-8000-000000000002", role: "member" };
const MAINTAINER = { id: "00000000-0000-4000-8000-000000000003", role: "maintainer" };

let updater: FakeUpdater;

beforeAll(async () => {
  updater = await startFakeUpdater({ token: TOKEN });
});

afterAll(() => updater.close());

beforeEach(() => {
  vi.clearAllMocks();
  updater.calls.length = 0;
  updater.respond(() => ({ body: updaterStatus() }));
  mocks.getCurrentPerson.mockResolvedValue(ADMIN);
  mocks.updaterUrl = updater.url;
  mocks.updaterToken = TOKEN;
});

function get(): Promise<Response> {
  return routes.status.GET(new Request("https://library.example/api/admin/updates"));
}

function post(route: "check" | "install" | "channel", body?: unknown, origin: string | null = "https://library.example"): Promise<Response> {
  const text = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  // As browsers send them.
  const headers: Record<string, string> = { "content-type": "application/json", "content-length": String(Buffer.byteLength(text ?? "")) };
  if (origin) headers.origin = origin;
  return routes[route].POST(new Request(`https://library.example/api/admin/updates/${route}`, { method: "POST", headers, body: text }));
}

describe("/api/admin/updates", () => {
  it("answers 404 without a session and to people who are not admins, maintainers too, without asking the updater", async () => {
    for (const person of [null, MEMBER, MAINTAINER]) {
      mocks.getCurrentPerson.mockResolvedValue(person);
      for (const response of [await get(), await post("check"), await post("install", { version: "0.2.1" }), await post("channel", { channel: "preview" })]) {
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }
    expect(updater.calls).toEqual([]);
  });

  it("refuses POSTs from other sites, without an Origin, and with a large body, without asking the updater", async () => {
    for (const origin of ["https://evil.example", null]) {
      expect((await post("install", { version: "0.2.1" }, origin)).status).toBe(403);
      expect((await post("channel", { channel: "preview" }, origin)).status).toBe(403);
      expect((await post("check", undefined, origin)).status).toBe(403);
    }
    expect((await post("install", { version: "0.2.1", padding: "x".repeat(2_000) })).status).toBe(413);
    expect(updater.calls).toEqual([]);
  });

  it("answers the status for admins, without caching, and sends UPDATER_TOKEN", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ app: { version: "0.2.0" }, reachable: true, updater: updaterStatus(), error: null });
    expect(updater.calls).toEqual([{ method: "GET", path: "/v1/status", body: null, authorization: `Bearer ${TOKEN}` }]);
  });

  it("passes check, install, and channel on to the updater, with the token", async () => {
    updater.respond((call) =>
      call.path === "/v1/install"
        ? { status: 202, body: updaterStatus({ installing: { version: "0.2.1", startedAt: "2026-11-24T10:00:00.000Z", manual: true, stage: "requested" } }) }
        : { body: updaterStatus() },
    );
    expect((await post("check")).status).toBe(200);
    expect((await post("install", { version: "0.2.1" })).status).toBe(202);
    expect((await post("channel", { channel: "preview" })).status).toBe(200);
    expect(updater.calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "POST", path: "/v1/check", body: null },
      { method: "POST", path: "/v1/install", body: { version: "0.2.1" } },
      { method: "POST", path: "/v1/channel", body: { channel: "preview" } },
    ]);
    expect(updater.calls.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("refuses an invalid version before it calls the updater", async () => {
    for (const body of [{ version: "latest" }, { version: "0.2.1; rm -rf /" }, {}, "not json"]) {
      expect((await post("install", body)).status).toBe(400);
    }
    expect(updater.calls).toEqual([]);
  });

  it("says that UPDATER_TOKEN is missing when the updater needs one", async () => {
    mocks.updaterToken = undefined;
    const response = await get();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reachable: true, updater: null, error: expect.stringContaining("UPDATER_TOKEN") });
    expect(updater.calls).toEqual([{ method: "GET", path: "/v1/status", body: null, authorization: null }]);
  });
});
