import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answer, release, status } from "../../../tests/fixtures/updates";
import type { UpdatesResponse } from "@/lib/updates/types";

/*
 * The update status in the browser, with fake timers and a fake library: the
 * deadline of an unclear install request, Stop waiting, and a session that
 * ended. The pure rules are tested in src/lib/updates/state.test.ts.
 */

const NOW = Date.parse("2026-11-19T10:00:00.000Z");
const INSTALLING = { version: "0.2.1", startedAt: "2026-11-19T10:00:00Z", manual: true, stage: "pulling" as const };

/** What the fake library answers: a response, a network error, or nothing at all. */
type Reply = () => Response | Error | "stall";

const json = (code: number, body: UpdatesResponse): Response =>
  new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

let replies: { status: Reply; install: Reply };
const fetchMock = vi.fn(async (url: string) => {
  const reply = (url.endsWith("/install") ? replies.install : replies.status)();
  if (reply === "stall") return new Promise<Response>(() => {});
  if (reply instanceof Error) throw reply;
  return reply;
});
const statusRequests = () => fetchMock.mock.calls.filter(([url]) => url === "/api/admin/updates").length;

const storage = new Map<string, string>();
const win = new EventTarget();

type Store = typeof import("./use-updates");
let store: Store;
let stop: () => void;

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW });
  storage.clear();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", win);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  });
  replies = { status: () => json(200, answer(status({ available: release("0.2.1") }))), install: () => new TypeError("Failed to fetch") };
  vi.resetModules();
  store = await import("./use-updates");
  stop = store.start();
  await vi.advanceTimersByTimeAsync(0);
});

afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("an install request without a clear answer", () => {
  it("ends 60 seconds after the attempt while every request fails: the installation could not be confirmed", async () => {
    replies.status = () => new TypeError("Failed to fetch");
    await store.updates.install("0.2.1");
    await vi.advanceTimersByTimeAsync(59_000);
    expect(store.readUpdates().wait).toMatchObject({ version: "0.2.1", confirmed: false, outage: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.readUpdates().wait).toBeNull();
    expect(store.readUpdates().actionError).toEqual({ title: "The installation could not be confirmed", message: "The library did not answer." });
    expect(storage.has("library.update-install")).toBe(false);
  });

  it("ends on time while the status requests hang", async () => {
    replies.status = () => "stall";
    await store.updates.install("0.2.1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.readUpdates().wait).toBeNull();
    expect(store.readUpdates().actionError?.title).toBe("The installation could not be confirmed");
  });

  it("says that the installation did not start when the updater answered without it", async () => {
    replies.status = () => json(200, answer(status()));
    await store.updates.install("0.2.1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.readUpdates().wait).toBeNull();
    expect(store.readUpdates().actionError).toEqual({ title: "The installation did not start", message: "The library did not answer." });
  });

  it("follows the installation once a status reports it", async () => {
    replies.status = () => json(200, answer(status({ installing: INSTALLING })));
    await store.updates.install("0.2.1");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.readUpdates().wait).toMatchObject({ confirmed: true, startedAt: INSTALLING.startedAt });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.readUpdates().wait).toMatchObject({ version: "0.2.1" });
    expect(store.readUpdates().actionError).toBeNull();
  });
});

describe("following an installation", () => {
  it("says after 15 minutes that it takes longer, also while no request returns", async () => {
    replies.status = () => json(200, answer(status({ installing: INSTALLING })));
    await store.updates.refresh();
    expect(store.readUpdates().wait).toMatchObject({ version: "0.2.1", mine: false });
    replies.status = () => "stall";
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(store.readUpdates().slow).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.readUpdates().slow).toBe(true);
  });

  it("Stop waiting while the updater is unreachable ignores that installation when the updater is back", async () => {
    replies.status = () => json(200, answer(status({ installing: INSTALLING })));
    await store.updates.refresh();
    replies.status = () => json(200, answer(null, { error: "The update service at http://updater:8080 is not reachable (connection refused)." }));
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(store.readUpdates()).toMatchObject({ slow: true, wait: { startedAt: INSTALLING.startedAt, outage: true, restarting: true } });

    store.updates.stopWaiting();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.readUpdates().wait).toBeNull();
    replies.status = () => json(200, answer(status({ installing: INSTALLING })));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(store.readUpdates().response?.updater?.installing).toEqual(INSTALLING);
    expect(store.readUpdates().wait).toBeNull();

    // Another installation of the version is followed.
    replies.status = () => json(200, answer(status({ installing: { ...INSTALLING, startedAt: "2026-11-19T10:30:00Z" } })));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(store.readUpdates().wait).toMatchObject({ startedAt: "2026-11-19T10:30:00Z" });
  });

  it("stops every automatic request at a sign-in page and keeps the attempt", async () => {
    replies.status = () => json(200, answer(status({ installing: INSTALLING })));
    await store.updates.refresh();
    replies.status = () => new Response("<!doctype html><title>Sign in</title>", { status: 200, headers: { "content-type": "text/html" } });
    await vi.advanceTimersByTimeAsync(2_000);
    const requests = statusRequests();
    expect(store.readUpdates().actionError?.title).toBe("Your session ended");

    await vi.advanceTimersByTimeAsync(20 * 60_000);
    win.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(statusRequests()).toBe(requests);
    expect(store.readUpdates().wait).toMatchObject({ version: "0.2.1", startedAt: INSTALLING.startedAt });
    expect(JSON.parse(storage.get("library.update-install")!)).toMatchObject({ version: "0.2.1" });
  });
});
