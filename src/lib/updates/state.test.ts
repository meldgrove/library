import { describe, expect, it } from "vitest";
import { answer, release, status } from "../../../tests/fixtures/updates";
import {
  afterInstallAnswer,
  automaticLine,
  buttonState,
  channelError,
  checkError,
  dismissal,
  formatCooldown,
  gaveUp,
  installAction,
  installOutcome,
  installsLine,
  isDismissed,
  isSlow,
  newAttempt,
  RECONCILE_MS,
  relativeTime,
  replacedFailure,
  reportedFailure,
  safeLink,
  SIGNED_OUT,
  stableDescription,
  stageLabel,
  startWait,
  unconfirmedError,
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
  startedAt: "2026-11-19T10:00:00.000Z",
  earlier: null,
  since: NOW,
  mine: true,
  confirmed: true,
  giveUpAt: null,
  reason: null,
  error: null,
  answered: false,
  outage: false,
  restarting: false,
  ...extra,
});

const installing = (stage: "requested" | "pulling" | "starting" = "starting") => ({
  version: "0.2.1",
  startedAt: "2026-11-19T10:00:00.000Z",
  manual: true,
  stage,
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
    expect(state(status({ mode: "off", automatic: false }))).toBe("off");
    // Off installs nothing, but still offers new versions.
    expect(state(status({ mode: "off", automatic: false, available: release("0.2.1") }))).toBe("available");
    expect(state(status({ mode: "off", automatic: false, attention: release("0.3.0") }))).toBe("attention");
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

  it("shows a newer offer over a failure from this page, with the failure as a line in it", () => {
    const failure = { version: "0.2.1", message: "container web is unhealthy. 0.2.0 runs again.", mine: true };
    const newer = status({ available: release("0.2.2"), last: failedStatus.last });
    expect(state(newer, { failure })).toBe("available");
    expect(replacedFailure(failure, newer)).toEqual(failure);
    expect(state(status({ attention: release("0.3.0") }), { failure })).toBe("attention");
    // Still offered, or nothing else offered: the failure itself shows.
    expect(state(status({ available: release("0.2.1"), attention: release("0.3.0") }), { failure })).toBe("failed");
    expect(replacedFailure(failure, status({ available: release("0.2.1") }))).toBeNull();
    expect(state(status(), { failure })).toBe("failed");
    expect(replacedFailure(failure, status())).toBeNull();
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
  const last = (result: "installed" | "failed" | "rolled-back" | "accepted", extra: object = {}) => ({
    version: "0.2.1",
    result,
    message: null,
    finishedAt: "2026-11-19T10:00:08.000Z",
    ...extra,
  });
  const withLast = (result: "installed" | "failed" | "rolled-back" | "accepted", extra: object = {}) => status({ last: last(result, extra) });

  it("keeps waiting while the updater still installs the version, even when the library already answers with it", () => {
    const outcome = installOutcome(wait(), answer(status({ installing: installing() }), { app: { version: "0.2.1" } }));
    expect(outcome).toEqual({ kind: "waiting", wait: wait({ answered: true }) });
  });

  it("is done when the server installed it", () => {
    expect(installOutcome(wait(), answer(withLast("installed")))).toEqual({ kind: "done" });
    expect(installOutcome(wait({ from: null }), answer(withLast("installed"), { app: { version: null } }))).toEqual({ kind: "done" });
  });

  it("fails with the updater's message, also when the version is no longer offered as failed", () => {
    const message = "container worker is unhealthy. 0.2.0 runs again.";
    // The new web process answered with the version for a moment; the worker then failed its health check.
    expect(installOutcome(wait({ outage: true }), answer(withLast("rolled-back", { message }), { app: { version: "0.2.1" } }))).toEqual({ kind: "failed", message });
    expect(installOutcome(wait(), answer(withLast("failed", { message: "pull access denied" })))).toEqual({ kind: "failed", message: "pull access denied" });
  });

  it("ignores a result from before the attempt", () => {
    const stale = { finishedAt: "2026-11-19T09:00:00.000Z" };
    expect(installOutcome(wait(), answer(withLast("rolled-back", stale)))).toEqual({ kind: "waiting", wait: wait({ answered: true }) });
    expect(installOutcome(wait(), answer(withLast("installed", stale)))).toEqual({ kind: "waiting", wait: wait({ answered: true }) });
    // Without the updater's clock, the browser's; and the result known when the attempt started never counts.
    expect(installOutcome(wait({ startedAt: null }), answer(withLast("failed", stale)))).toMatchObject({ kind: "waiting" });
    expect(installOutcome(wait({ startedAt: null, since: 0, earlier: last("failed") }), answer(withLast("failed")))).toMatchObject({
      kind: "waiting",
    });
  });

  it("compares with the updater's whole seconds: a result in the second the attempt started is fresh", () => {
    // The install request's answer was lost; the platform accepted it in the same second (10:00:00.700 in the browser).
    const lost = afterInstallAnswer(newAttempt("0.2.1", answer(status({ mode: "platform" })), NOW + 700), { kind: "down", reason: "The library did not answer." }, NOW + 700);
    const accepted = answer(status({ mode: "platform", last: last("accepted", { finishedAt: "2026-11-19T10:00:00Z" }) }));
    const outcome = installOutcome(lost.wait!, accepted);
    expect(outcome).toMatchObject({ kind: "waiting", wait: { confirmed: true } });
    if (outcome.kind !== "waiting") throw new Error("not waiting");
    expect(gaveUp(outcome.wait, NOW + 700 + RECONCILE_MS)).toBe(false);
    expect(installOutcome(outcome.wait, { ...accepted, app: { version: "0.2.1" } })).toEqual({ kind: "done" });
    // A result of the second before is not.
    expect(installOutcome(lost.wait!, answer(status({ last: last("accepted", { finishedAt: "2026-11-19T09:59:59Z" }) })))).toMatchObject({
      kind: "waiting",
      wait: { confirmed: false },
    });
  });

  it("does not take the earlier result as its own when a retry starts in the same second", () => {
    const failed = last("failed", { message: "pull access denied", finishedAt: "2026-11-19T10:00:05Z" });
    const retry = afterInstallAnswer(
      newAttempt("0.2.1", answer(status({ available: release("0.2.1"), last: failed })), Date.parse("2026-11-19T10:00:05.400Z")),
      { kind: "down", reason: "The library did not answer." },
      Date.parse("2026-11-19T10:00:05.400Z"),
    ).wait!;
    expect(retry.earlier).toEqual(failed);
    expect(installOutcome(retry, answer(status({ available: release("0.2.1"), last: failed })))).toMatchObject({ kind: "waiting", wait: { confirmed: false } });
    // Another result in the same second is the retry's.
    expect(installOutcome(retry, answer(status({ last: { ...failed, result: "installed", message: null } })))).toEqual({ kind: "done" });
  });

  it("ignores results of other versions while the updater installs", () => {
    expect(installOutcome(wait(), answer(status({ installing: installing(), last: last("failed", { version: "0.2.0" }) })))).toMatchObject({ kind: "waiting" });
  });

  it("waits for a platform's deployment until the library runs the version", () => {
    expect(installOutcome(wait(), answer(withLast("accepted")))).toMatchObject({ kind: "waiting" });
    expect(installOutcome(wait({ outage: true }), answer(withLast("accepted")))).toMatchObject({ kind: "waiting" });
    expect(installOutcome(wait(), answer(withLast("accepted"), { app: { version: "0.2.1" } }))).toEqual({ kind: "done" });
    // Without a version (development): once the library answered after an outage.
    expect(installOutcome(wait({ from: null }), answer(withLast("accepted"), { app: { version: null } }))).toMatchObject({ kind: "waiting" });
    expect(installOutcome(wait({ from: null, outage: true }), answer(withLast("accepted"), { app: { version: null } }))).toEqual({ kind: "done" });
  });

  it("is done when nothing reports the installation any more and the library runs the version", () => {
    expect(installOutcome(wait(), answer(status(), { app: { version: "0.2.1" } }))).toEqual({ kind: "done" });
    expect(installOutcome(wait(), answer(status()))).toEqual({ kind: "waiting", wait: wait({ answered: true }) });
  });

  it("keeps waiting while the updater cannot be asked, and counts that as an outage", () => {
    const error = "The update service at http://updater:8080 is not reachable (connection refused).";
    expect(installOutcome(wait(), answer(null, { error }))).toEqual({ kind: "waiting", wait: wait({ restarting: true, outage: true, error }) });
    expect(installOutcome(wait(), answer(null, { app: { version: "0.2.1" } }))).toMatchObject({ kind: "waiting" });
  });

  it("completes a platform's deployment without an app version after reachable: false, once the updater answers again", () => {
    const development = wait({ from: null, startedAt: null });
    const accepted = answer(withLast("accepted"), { app: { version: null } });
    expect(installOutcome(development, accepted)).toMatchObject({ kind: "waiting", wait: { confirmed: true, outage: false } });
    const restarted = installOutcome(development, answer(null, { app: { version: null } }));
    expect(restarted).toMatchObject({ kind: "waiting", wait: { outage: true, restarting: true } });
    if (restarted.kind !== "waiting") throw new Error("not waiting");
    expect(installOutcome(restarted.wait, accepted)).toEqual({ kind: "done" });
  });

  it("confirms an attempt once a status reports it, with the updater's clock", () => {
    const attempt = wait({ startedAt: null, confirmed: false, giveUpAt: NOW + RECONCILE_MS });
    expect(installOutcome(attempt, answer(status({ installing: installing("pulling") })))).toEqual({
      kind: "waiting",
      wait: { ...attempt, confirmed: true, answered: true, startedAt: "2026-11-19T10:00:00.000Z" },
    });
  });

  it("follows another version the updater installs instead", () => {
    expect(installOutcome(wait(), answer(status({ installing: { ...installing(), version: "0.2.2" } })))).toEqual({ kind: "other" });
  });

  it("says after 15 minutes that it takes longer than expected", () => {
    expect(isSlow(wait(), NOW + 14 * 60_000)).toBe(false);
    expect(isSlow(wait(), NOW + 16 * 60_000)).toBe(true);
  });
});

describe("install requests", () => {
  const attempt = newAttempt("0.2.1", answer(failedStatus), NOW);

  it("remembers the attempt before the request, with the result known then", () => {
    expect(attempt).toEqual(wait({ startedAt: null, earlier: failedStatus.last, confirmed: false }));
  });

  it("follows an accepted installation with the updater's clock", () => {
    const accepted = afterInstallAnswer(attempt, { kind: "answer", httpStatus: 202, body: answer(status({ installing: installing("requested") })) }, NOW);
    expect(accepted).toEqual({ wait: { ...attempt, confirmed: true, startedAt: "2026-11-19T10:00:00.000Z" }, error: null });
    const platform = afterInstallAnswer(attempt, { kind: "answer", httpStatus: 202, body: answer(status({ mode: "platform", last: { version: "0.2.1", result: "accepted", message: null, finishedAt: "2026-11-19T10:00:02.000Z" } })) }, NOW);
    expect(platform.wait).toMatchObject({ confirmed: true, startedAt: null });
  });

  it("follows a 202 whose body cannot be read, and takes another 4xx as a refusal", () => {
    expect(afterInstallAnswer(attempt, { kind: "down", httpStatus: 202, reason: "The library answered with HTTP 202." }, NOW)).toEqual({
      wait: { ...attempt, confirmed: true },
      error: null,
    });
    expect(afterInstallAnswer(attempt, { kind: "down", httpStatus: 429, reason: "The library answered with HTTP 429." }, NOW)).toEqual({
      wait: null,
      error: "The library answered with HTTP 429.",
    });
  });

  it("keeps the attempt after an unclear answer and looks for it until a minute after it started", () => {
    const lost = afterInstallAnswer(attempt, { kind: "down", reason: "The library did not answer." }, NOW + 20_000);
    const reason = "The library did not answer.";
    expect(lost).toEqual({ wait: { ...attempt, giveUpAt: NOW + RECONCILE_MS, reason, error: reason, outage: true, restarting: true }, error: null });
    const unavailable = "The update service could not start the installation.";
    const serverError = afterInstallAnswer(attempt, { kind: "down", httpStatus: 503, reason: unavailable }, NOW);
    expect(serverError.wait).toMatchObject({ confirmed: false, giveUpAt: NOW + RECONCILE_MS, reason: unavailable });
    const timeout = "The update service at http://updater:8080 did not answer within 10 seconds.";
    const noUpdater = afterInstallAnswer(attempt, { kind: "answer", httpStatus: 200, body: answer(null, { error: timeout }) }, NOW);
    expect(noUpdater.wait).toMatchObject({ confirmed: false, giveUpAt: NOW + RECONCILE_MS, reason: timeout, outage: true });
    expect(gaveUp(lost.wait!, NOW + RECONCILE_MS - 1)).toBe(false);
    expect(gaveUp(lost.wait!, NOW + RECONCILE_MS)).toBe(true);
    expect(gaveUp({ ...lost.wait!, confirmed: true }, NOW + RECONCILE_MS)).toBe(false);
    // While the request runs, there is no deadline yet.
    expect(gaveUp(attempt, NOW + RECONCILE_MS)).toBe(false);
  });

  it("forgets the attempt when the updater refuses it", () => {
    const refused = afterInstallAnswer(attempt, { kind: "answer", httpStatus: 409, body: answer(status(), { error: "0.2.1 is not offered; check again." }) }, NOW);
    expect(refused).toEqual({ wait: null, error: "0.2.1 is not offered; check again." });
    expect(afterInstallAnswer(attempt, { kind: "denied" }, NOW)).toEqual({ wait: null, error: SIGNED_OUT });
  });

  it("follows the installation a refusal reports instead", () => {
    const running = { ...installing("pulling"), version: "0.2.2", manual: false };
    const refused = afterInstallAnswer(attempt, { kind: "answer", httpStatus: 409, body: answer(status({ installing: running }), { error: "0.2.2 is being installed." }) }, NOW);
    expect(refused).toEqual({
      wait: { ...attempt, version: "0.2.2", startedAt: "2026-11-19T10:00:00.000Z", earlier: null, mine: false, confirmed: true },
      error: null,
    });
    // Another admin was faster with the same version: its failure still opens by itself here.
    const same = afterInstallAnswer(attempt, { kind: "answer", httpStatus: 409, body: answer(status({ installing: installing() }), { error: "0.2.1 is being installed." }) }, NOW);
    expect(same.wait).toMatchObject({ version: "0.2.1", mine: true, confirmed: true });
  });

  it("starts following a reported installation from the updater's clock", () => {
    const reported = status({ installing: { ...installing("requested"), startedAt: "2026-11-19T09:59:59.000Z" } });
    expect(startWait("0.2.1", answer(reported), false, NOW)).toEqual(wait({ startedAt: "2026-11-19T09:59:59.000Z", mine: false }));
  });

  it("says at the deadline whether the installation did not start or could not be confirmed", () => {
    const lost = wait({ startedAt: null, confirmed: false, giveUpAt: NOW + RECONCILE_MS, reason: "The library did not answer.", error: "The library answered with HTTP 502." });
    expect(unconfirmedError(lost)).toEqual({ title: "The installation could not be confirmed", message: "The library answered with HTTP 502." });
    expect(unconfirmedError({ ...lost, answered: true })).toEqual({ title: "The installation did not start", message: "The library did not answer." });
    expect(unconfirmedError(wait({ confirmed: false, answered: true }))).toEqual({
      title: "The installation did not start",
      message: "The update service did not report an installation of 0.2.1.",
    });
  });
});

describe("Stop waiting", () => {
  it("ignores the installation by its identity", () => {
    const dismissed = dismissal(wait());
    expect(isDismissed(dismissed, installing())).toBe(true);
    expect(isDismissed(dismissed, { ...installing(), startedAt: "2026-11-19T10:30:00Z" })).toBe(false);
    expect(isDismissed(dismissed, { ...installing(), version: "0.2.2" })).toBe(false);
    expect(isDismissed(null, installing())).toBe(false);
  });

  it("without an identity, ignores the version from the attempt's start on", () => {
    const dismissed = dismissal(wait({ startedAt: null, since: NOW + 700 }));
    expect(isDismissed(dismissed, installing())).toBe(true);
    expect(isDismissed(dismissed, { ...installing(), startedAt: "2026-11-19T10:00:02Z" })).toBe(true);
    expect(isDismissed(dismissed, { ...installing(), startedAt: "2026-11-19T09:59:00Z" })).toBe(false);
  });
});

describe("installAction", () => {
  it("offers Install anyway for a release with upgrade steps only where the channel is not locked", () => {
    expect(installAction(status({ attention: release("0.3.0") }), true)).toBe("install");
    const locked = status({ mode: "platform", channelLocked: "The platform's image tag 0.2 decides which updates install.", attention: release("0.3.0") });
    expect(installAction(locked, true)).toBe("locked");
    expect(installAction(locked, false)).toBe("install");
    expect(installAction(status({ mode: "off", automatic: false }), true)).toBe("off");
    expect(installAction(null, false)).toBe("off");
  });
});

describe("check and channel answers", () => {
  it("shows why a check failed instead of Up to date", () => {
    expect(checkError({ kind: "answer", httpStatus: 200, body: answer(status()) })).toBeNull();
    expect(checkError({ kind: "answer", httpStatus: 200, body: answer(status({ error: "ghcr.io: 503 Service Unavailable" })) })).toBe("ghcr.io: 503 Service Unavailable");
    expect(checkError({ kind: "answer", httpStatus: 409, body: answer(status(), { error: "A check runs already." }) })).toBe("A check runs already.");
    expect(checkError({ kind: "down", reason: "The library did not answer." })).toBe("The library did not answer.");
  });

  it("counts a channel as saved only when the updater reports it", () => {
    expect(channelError({ kind: "answer", httpStatus: 200, body: answer(status({ channel: "preview" })) }, "preview")).toBeNull();
    expect(channelError({ kind: "answer", httpStatus: 200, body: answer(status()) }, "preview")).toBe("The update service still uses the channel Stable.");
    expect(channelError({ kind: "answer", httpStatus: 200, body: answer(null, { error: "not reachable" }) }, "preview")).toBe("not reachable");
    expect(channelError({ kind: "answer", httpStatus: 409, body: answer(status(), { error: "locked" }) }, "preview")).toBe("locked");
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
