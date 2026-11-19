import { describe, expect, it } from "vitest";
import { answer, release, status } from "../../../tests/fixtures/updates";
import {
  automaticLine,
  buttonState,
  formatCooldown,
  installOutcome,
  installsLine,
  isSlow,
  relativeTime,
  reportedFailure,
  safeLink,
  stableDescription,
  stageLabel,
  startWait,
  visibleNotes,
  type InstallWait,
} from "./state";
import type { Status } from "./types";

const NOW = Date.parse("2026-11-19T10:00:00.000Z");

const state = (updater: Status | null, extra: Partial<Parameters<typeof buttonState>[0]> = {}) =>
  buttonState({ response: answer(updater), checking: false, wait: null, failure: null, ...extra });

const failedStatus = status({
  available: release("0.2.1", { installsAt: null, failed: 'service "migrate" didn\'t complete successfully: exit 1' }),
  last: { version: "0.2.1", result: "rolled-back", message: "container web is unhealthy. 0.2.0 runs again.", finishedAt: "2026-11-19T09:00:00.000Z" },
});

const wait = (extra: Partial<InstallWait> = {}): InstallWait => ({
  version: "0.2.1",
  from: "0.2.0",
  requestedAt: "2026-11-19T10:00:00.000Z",
  since: NOW,
  mine: true,
  outage: false,
  restarting: false,
  ...extra,
});

describe("buttonState", () => {
  it("derives every state of the button", () => {
    expect(buttonState({ response: null, checking: false, wait: null, failure: null })).toBe("loading");
    expect(state(status())).toBe("up-to-date");
    expect(state(status(), { checking: true })).toBe("checking");
    expect(state(status({ checking: true }))).toBe("checking");
    expect(state(status({ available: release("0.2.1") }))).toBe("available");
    expect(state(status({ attention: release("0.3.0") }))).toBe("attention");
    expect(state(status({ available: release("0.2.1"), attention: release("0.3.0") }))).toBe("available");
    expect(state(status({ installing: { version: "0.2.1", startedAt: "2026-11-19T10:00:00.000Z", manual: true, stage: "pulling" } }))).toBe("installing");
    expect(state(failedStatus)).toBe("failed");
    expect(state(status({ mode: "off", automatic: false, available: release("0.2.1") }))).toBe("off");
    expect(state(null)).toBe("unreachable");
  });

  it("shows the installation the page waits for, even while the library restarts", () => {
    expect(buttonState({ response: null, checking: false, wait: wait({ restarting: true }), failure: null })).toBe("installing");
    expect(state(status({ available: release("0.2.1") }), { wait: wait() })).toBe("installing");
  });

  it("shows a failure the page saw, and an earlier failure only when the updater still offers the version", () => {
    expect(state(status({ attention: release("0.3.0") }), { failure: { version: "0.3.0", message: "exit 1" } })).toBe("failed");
    // The failed version was replaced by a newer one without a failure.
    expect(state(status({ available: release("0.2.2"), last: failedStatus.last }))).toBe("available");
  });
});

describe("reportedFailure", () => {
  it("takes the updater's message for the failed version", () => {
    expect(reportedFailure(failedStatus)).toEqual({ version: "0.2.1", message: "container web is unhealthy. 0.2.0 runs again." });
    expect(reportedFailure(status({ available: release("0.2.1") }))).toBeNull();
    expect(reportedFailure(null)).toBeNull();
  });
});

describe("installOutcome", () => {
  const last = (result: "installed" | "failed" | "rolled-back" | "accepted", extra: object = {}) =>
    status({ last: { version: "0.2.1", result, message: null, finishedAt: "2026-11-19T10:00:08.000Z", ...extra } });

  it("is done when the library runs the version", () => {
    expect(installOutcome(wait(), answer(status(), { app: { version: "0.2.1" } }))).toBe("done");
  });

  it("is done when the updater installed it and the library changed or has no version", () => {
    expect(installOutcome(wait({ outage: true }), answer(last("installed")))).toBe("done");
    expect(installOutcome(wait({ from: null }), answer(last("installed"), { app: { version: null } }))).toBe("done");
    expect(installOutcome(wait(), answer(last("installed")))).toBe("waiting");
  });

  it("waits for a platform's deployment until the library changed", () => {
    expect(installOutcome(wait(), answer(last("accepted")))).toBe("waiting");
    expect(installOutcome(wait({ outage: true }), answer(last("accepted")))).toBe("done");
    expect(installOutcome(wait(), answer(last("accepted"), { app: { version: "0.2.1-preview.1" } }))).toBe("done");
    expect(installOutcome(wait({ from: null }), answer(last("accepted"), { app: { version: null } }))).toBe("waiting");
  });

  it("fails when the updater says so", () => {
    expect(installOutcome(wait(), answer(last("failed")))).toBe("failed");
    expect(installOutcome(wait({ outage: true }), answer(last("rolled-back")))).toBe("failed");
  });

  it("ignores results of other versions and of earlier attempts while the updater installs", () => {
    const installing = { version: "0.2.1", startedAt: "2026-11-19T10:00:00.000Z", manual: true, stage: "starting" as const };
    expect(installOutcome(wait(), answer(status({ installing, last: last("failed", { version: "0.2.0" }).last })))).toBe("waiting");
    expect(installOutcome(wait(), answer(status({ installing, last: last("rolled-back", { finishedAt: "2026-11-19T09:00:00.000Z" }).last })))).toBe("waiting");
    expect(installOutcome(wait(), answer(status({ installing })))).toBe("waiting");
  });

  it("keeps waiting while the updater cannot be asked, and stops when the installation is gone", () => {
    expect(installOutcome(wait(), answer(null))).toBe("waiting");
    expect(installOutcome(wait(), answer(status()))).toBe("gone");
    expect(installOutcome(wait(), answer(last("rolled-back", { finishedAt: "2026-11-19T09:00:00.000Z" })))).toBe("gone");
  });

  it("starts waiting from the updater's clock", () => {
    const installing = status({ installing: { version: "0.2.1", startedAt: "2026-11-19T09:59:59.000Z", manual: true, stage: "requested" } });
    expect(startWait("0.2.1", answer(installing), true, NOW)).toEqual(wait({ requestedAt: "2026-11-19T09:59:59.000Z" }));
    expect(startWait("0.2.1", answer(last("accepted")), true, NOW).requestedAt).toBe("2026-11-19T10:00:08.000Z");
    expect(startWait("0.2.1", answer(status()), false, NOW)).toMatchObject({ requestedAt: null, mine: false });
  });

  it("says after 15 minutes that it takes longer than expected", () => {
    expect(isSlow(wait(), NOW + 14 * 60_000)).toBe(false);
    expect(isSlow(wait(), NOW + 16 * 60_000)).toBe(true);
  });
});

describe("texts", () => {
  it("names the stages", () => {
    expect(stageLabel("pulling", "0.2.0")).toBe("Downloading");
    expect(stageLabel("starting", "0.2.0")).toBe("Starting");
    expect(stageLabel("rolling-back", "0.2.0")).toBe("Going back to 0.2.0");
    expect(stageLabel("deploying", "0.2.0")).toBe("Deploying");
    expect(stageLabel("requested", "0.2.0")).toBe("Waiting for the server");
  });

  it("says how long ago something happened", () => {
    expect(relativeTime("2026-11-19T09:59:40.000Z", NOW)).toBe("just now");
    expect(relativeTime("2026-11-19T09:55:00.000Z", NOW)).toBe("5 min ago");
    expect(relativeTime("2026-11-19T09:00:00.000Z", NOW)).toBe("1 hour ago");
    expect(relativeTime("2026-11-17T08:00:00.000Z", NOW)).toBe("2 days ago");
    expect(relativeTime(null, NOW)).toBeNull();
  });

  it("says when an update installs by itself", () => {
    const format = (value: Date) => value.toISOString();
    expect(installsLine(release("0.2.1"), NOW, format)).toBe("Installs automatically on 2026-11-21T02:00:00.000Z");
    expect(installsLine(release("0.2.1", { installsAt: "2026-11-19T09:00:00.000Z" }), NOW, format)).toBe("Installs automatically at the next check");
    expect(installsLine(release("0.2.1", { installsAt: null }), NOW, format)).toBeNull();
  });

  it("lists at most 8 notes and counts the rest", () => {
    const notes = Array.from({ length: 15 }, (_, index) => `Change ${index + 1}`);
    expect(visibleNotes(release("0.2.1", { notes, changes: 23 }))).toEqual({ notes: notes.slice(0, 8), more: 15 });
    expect(visibleNotes(release("0.2.1"))).toEqual({ notes: ["Show who changed a note last", "Fix the sign-in loop behind some proxies"], more: 0 });
  });

  it("links only to web pages", () => {
    expect(safeLink("https://github.com/meldgrove/library/releases/tag/v0.2.1")).toBe("https://github.com/meldgrove/library/releases/tag/v0.2.1");
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("not a url")).toBeNull();
    expect(safeLink(null)).toBeNull();
  });

  it("writes the cooldown in words", () => {
    expect(formatCooldown("3d")).toBe("3 days");
    expect(formatCooldown("1d")).toBe("1 day");
    expect(formatCooldown("12h")).toBe("12 hours");
    expect(formatCooldown("30m")).toBe("30 minutes");
    expect(formatCooldown("90")).toBe("90 seconds");
    expect(formatCooldown("0")).toBeNull();
    expect(formatCooldown(null)).toBeNull();
    expect(stableDescription("3d")).toBe("Releases. Updates that need no action install automatically after 3 days.");
  });

  it("says what installs by itself", () => {
    expect(automaticLine(status())).toBe("On: releases install automatically after 3 days, between 02:00 and 05:00 (UTC).");
    expect(automaticLine(status({ window: null, cooldown: null }))).toBe("On: releases install automatically within the hour.");
    expect(automaticLine(status({ channel: "preview", cooldown: null, window: null }))).toBe("On: previews and releases install automatically within the hour.");
    expect(automaticLine(status({ mode: "off", automatic: false }))).toBe("Off on this server: nothing installs automatically.");
    expect(automaticLine(status({ mode: "platform" }))).toBe("The platform installs them (deploy link).");
  });
});
