import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { buttonState, parseUpdatesResponse, type ButtonState } from "@meldgrove/ui/updates/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Answers captured from Meldgrove Updater 0.2 (tests/fixtures/updater-0.2), as
 * the API sends them, through the library's updater client and the update
 * button of @meldgrove/ui.
 */

const config = vi.hoisted(() => ({ UPDATER_URL: null as string | null }));

vi.mock("@/lib/config", () => ({
  getUpdaterConfig: () => ({ UPDATER_URL: config.UPDATER_URL }),
  getVersionConfig: () => ({ APP_VERSION: "0.1.1" }),
}));

const { callUpdater, updaterCalls } = await import("./updater");

const FIXTURES = path.resolve(import.meta.dirname, "../../../tests/fixtures/updater-0.2");
const samples = readdirSync(FIXTURES).filter((name) => name.endsWith(".json"));
const sample = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");
const httpStatusOf = (name: string) => (name.startsWith("install-202") ? 202 : 200);

/** The sample the updater answers with. */
let answering = "";
let server: Server;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(httpStatusOf(answering), { "content-type": "application/json" });
    response.end(sample(answering));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  config.UPDATER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("callUpdater", () => {
  it("has every sample", () => {
    expect(samples).toHaveLength(7);
  });

  it.each(samples)("passes %s on unchanged", async (name) => {
    answering = name;
    const result = await callUpdater(name.startsWith("install-202") ? updaterCalls.install("0.1.3") : updaterCalls.status());
    expect(result).toEqual({
      httpStatus: httpStatusOf(name),
      body: { app: { version: "0.1.1" }, reachable: true, updater: JSON.parse(sample(name)), error: null },
    });
  });
});

describe("the update button with the samples", () => {
  it.each([
    ["status-off-available-attention.json", "available"],
    ["status-host-available.json", "available"],
    ["status-platform-locked.json", "current"],
    ["status-installing.json", "installing"],
    ["status-failed.json", "failed"],
    ["status-preview.json", "failed"],
    ["install-202.json", "installing"],
  ] satisfies [string, ButtonState][])("%s is %s", async (name, expected) => {
    answering = name;
    const { body } = await callUpdater(updaterCalls.status());
    // What GET /api/admin/updates sends, as the button reads it.
    const response = parseUpdatesResponse(JSON.parse(JSON.stringify(body)));
    expect(response).not.toBeNull();
    expect(buttonState(response!, { checking: false, pending: null })).toBe(expected);
  });
});
