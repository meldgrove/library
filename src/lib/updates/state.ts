import { CHANNEL_LABELS, type Channel, type InstallStage, type Status, type Update, type UpdatesResponse } from "./types";

/*
 * What the update button and the admin page show, derived from an answer of
 * /api/admin/updates, and how the page follows an installation. Pure
 * functions, so that each state can be tested.
 */

export type ButtonState =
  | "loading"
  | "checking"
  | "up-to-date"
  | "available"
  | "attention"
  | "installing"
  | "failed"
  | "off"
  | "unreachable";

/**
 * An installation the page follows: it reloads once the new version runs.
 * An attempt from this page is remembered before its install request, so that
 * a page that loses the answer (the deployment restarts the library) still
 * finds it.
 */
export interface InstallWait {
  version: string;
  /** The library's version when the attempt started (null in development). */
  from: string | null;
  /** When the updater started it (its clock); null until an answer reports it. */
  requestedAt: string | null;
  /** `last.finishedAt` when the attempt started: that result belongs to an earlier installation. */
  before: string | null;
  /** When the attempt started (the browser's clock, ms). */
  since: number;
  /** Asked for on this page, not by the updater or another admin. */
  mine: boolean;
  /** The updater accepted it, or a status reports it. */
  confirmed: boolean;
  /** Not confirmed: when the page stops looking for it (ms); null while the install request runs. */
  giveUpAt: number | null;
  /** Why the install request got no clear answer. */
  reason: string | null;
  /** The library did not answer at least once: it restarted. */
  outage: boolean;
  /** The last request got no answer, or the updater did not answer. */
  restarting: boolean;
}

export interface Failure {
  version: string;
  message: string | null;
  /** This page asked for the installation: its message opens by itself. */
  mine?: boolean;
}

/** An answer of the routes under /api/admin/updates. */
export type Fetched =
  | { kind: "answer"; httpStatus: number; body: UpdatesResponse }
  /** No answer: a network error, a timeout, or a server error, as while the library restarts. */
  | { kind: "down"; reason: string }
  /** 401, 403, 404, or a redirect to the sign-in page: the session ended. */
  | { kind: "denied" };

/** After this long without a result, the button says to check the server. */
export const SLOW_INSTALL_MS = 15 * 60_000;

/** How long the page looks for an installation whose install request got no clear answer. */
export const RECONCILE_MS = 60_000;

export const SIGNED_OUT = "Your session ended. Sign in again.";

/** A failed installation the updater reports for the available update. */
export function reportedFailure(updater: Status | null): Failure | null {
  const available = updater?.available;
  const last = updater?.last;
  if (!available?.failed || !last || (last.result !== "failed" && last.result !== "rolled-back")) return null;
  return { version: available.version, message: (last.version === available.version ? last.message : null) ?? available.failed };
}

export function buttonState(input: {
  response: UpdatesResponse | null;
  /** A check from this page runs. */
  checking: boolean;
  wait: InstallWait | null;
  /** An installation from this page failed. */
  failure: Failure | null;
}): ButtonState {
  const { response, checking, wait, failure } = input;
  if (wait) return "installing";
  if (!response) return checking ? "checking" : "loading";
  const updater = response.updater;
  if (!response.reachable || !updater) return checking ? "checking" : "unreachable";
  if (updater.installing) return "installing";
  if (checking || updater.checking) return "checking";
  if (failure || reportedFailure(updater)) return "failed";
  // Also with automatic updates off: the updater still offers new versions.
  if (updater.available) return "available";
  if (updater.attention) return "attention";
  if (updater.mode === "off") return "off";
  return "up-to-date";
}

/** Whether the updater can install: with automatic updates off, it refuses. */
export function canInstall(updater: Status | null | undefined): boolean {
  return !!updater && updater.mode !== "off";
}

/**
 * What the popover offers for an update: "install"; "off" (the updater
 * installs nothing); or "locked", for a release with upgrade steps that the
 * image tag set where the library is deployed does not reach (a platform, or a
 * server set up with updater 0.1): the tag changes there, after the steps.
 */
export function installAction(updater: Status | null | undefined, attention: boolean): "install" | "off" | "locked" {
  if (!updater || !canInstall(updater)) return "off";
  return attention && updater.channelLocked !== null ? "locked" : "install";
}

/** The version being installed. */
export function installingVersion(response: UpdatesResponse | null, wait: InstallWait | null): string | null {
  return wait?.version ?? response?.updater?.installing?.version ?? null;
}

/** The version that runs now, as far as anyone knows. */
export function runningVersion(response: UpdatesResponse | null): string | null {
  return response?.updater?.installed ?? response?.app.version ?? null;
}

/** An attempt from this page, remembered before its install request. */
export function newAttempt(version: string, response: UpdatesResponse | null, now: number): InstallWait {
  return {
    version,
    from: response?.app.version ?? null,
    requestedAt: null,
    before: response?.updater?.last?.finishedAt ?? null,
    since: now,
    mine: true,
    confirmed: false,
    giveUpAt: null,
    reason: null,
    outage: false,
    restarting: false,
  };
}

/** Follows an installation that an answer reports: another admin's, or an automatic one. */
export function startWait(version: string, response: UpdatesResponse, mine: boolean, now: number): InstallWait {
  const updater = response.updater;
  return {
    ...newAttempt(version, response, now),
    requestedAt: updater?.installing?.version === version ? updater.installing.startedAt : null,
    mine,
    confirmed: true,
  };
}

/**
 * What the answer to an install request means for the attempt:
 *
 * - 202: the updater accepted it; follow it.
 * - Refused (4xx with an error, or the session ended): forget it and show
 *   why, unless the answer reports another installation (another admin or an
 *   automatic install was faster): follow that one instead.
 * - Anything else (no answer, a timeout, a server error, or no updater): the
 *   request may have reached the updater. Keep the attempt and look for it
 *   for RECONCILE_MS.
 */
export function afterInstallAnswer(attempt: InstallWait, fetched: Fetched, now: number): { wait: InstallWait | null; error: string | null } {
  if (fetched.kind === "denied") return { wait: null, error: SIGNED_OUT };
  if (fetched.kind === "answer") {
    const { httpStatus, body } = fetched;
    const updater = body.updater;
    if (httpStatus === 202) {
      const last = updater?.last;
      const requestedAt =
        updater?.installing?.version === attempt.version
          ? updater.installing.startedAt
          : last?.version === attempt.version && last.finishedAt !== attempt.before
            ? last.finishedAt
            : null;
      return { wait: { ...attempt, confirmed: true, requestedAt }, error: null };
    }
    if (httpStatus >= 400 && httpStatus < 500) {
      const installing = updater?.installing;
      if (installing) return { wait: startWait(installing.version, body, installing.version === attempt.version, now), error: null };
      return { wait: null, error: body.error ?? "The update service did not accept the installation." };
    }
  }
  const reason = fetched.kind === "down" ? fetched.reason : fetched.body.error;
  return { wait: { ...attempt, giveUpAt: now + RECONCILE_MS, reason }, error: null };
}

/** The updater's result for the attempt: its version, finished after the attempt started. */
export function attemptResult(wait: InstallWait, updater: Status | null): Status["last"] {
  const last = updater?.last;
  if (!last || last.version !== wait.version || last.finishedAt === wait.before) return null;
  const start = wait.requestedAt === null ? wait.since : Date.parse(wait.requestedAt);
  return Date.parse(last.finishedAt) >= start ? last : null;
}

export type InstallOutcome =
  | { kind: "waiting"; wait: InstallWait }
  | { kind: "done" }
  | { kind: "failed"; message: string | null }
  /** The updater installs another version: follow that one. */
  | { kind: "other" };

/**
 * Where the installation the page follows stands, from an answer to a
 * request sent after the attempt started. Only the updater concludes; while
 * it cannot be asked (it restarts too), the page waits. In this order:
 *
 * 1. a result `failed` or `rolled-back` for the version: failed;
 * 2. the updater still installs the version: waiting, even when the library
 *    already answers with it (on a server the result comes only after every
 *    service is healthy, and it may still roll back);
 * 3. a result `installed`: done;
 * 4. a result `accepted` (platform): done once the library runs the version,
 *    or, without a version (development), once it answered after an outage;
 * 5. nothing reports the installation any more and the library runs the
 *    version: done.
 */
export function installOutcome(wait: InstallWait, response: UpdatesResponse): InstallOutcome {
  const updater = response.reachable ? response.updater : null;
  if (!updater) return { kind: "waiting", wait: { ...wait, restarting: true } };
  const current = { ...wait, restarting: false };
  const last = attemptResult(wait, updater);
  const installing = updater.installing;
  const version = response.app.version;
  if (last?.result === "failed" || last?.result === "rolled-back") return { kind: "failed", message: last.message };
  if (installing?.version === wait.version) {
    return { kind: "waiting", wait: { ...current, confirmed: true, requestedAt: current.requestedAt ?? installing.startedAt } };
  }
  if (last?.result === "installed") return { kind: "done" };
  if (last?.result === "accepted") {
    if (version === wait.version || (version === null && wait.outage)) return { kind: "done" };
    return { kind: "waiting", wait: { ...current, confirmed: true, requestedAt: current.requestedAt ?? last.finishedAt } };
  }
  if (version !== null && version === wait.version) return { kind: "done" };
  if (installing) return { kind: "other" };
  return { kind: "waiting", wait: current };
}

/** An attempt with no clear answer that no status reported in time: it did not start. */
export function gaveUp(wait: InstallWait, now: number): boolean {
  return !wait.confirmed && wait.giveUpAt !== null && now >= wait.giveUpAt;
}

export function isSlow(wait: InstallWait, now: number): boolean {
  return now - wait.since > SLOW_INSTALL_MS;
}

/** Why a manual check failed: the route refused it, or the updater's check went wrong. */
export function checkError(fetched: Fetched): string | null {
  switch (fetched.kind) {
    case "down":
      return fetched.reason;
    case "denied":
      return SIGNED_OUT;
    case "answer": {
      const { httpStatus, body } = fetched;
      if (httpStatus !== 200) return body.error ?? "The update service refused the check.";
      if (!body.reachable) return body.error ?? "The update service is not reachable.";
      return body.updater?.error ?? null;
    }
  }
}

/** Why a channel was not saved; it counts as saved only when the updater reports it. */
export function channelError(fetched: Fetched, channel: Channel): string | null {
  switch (fetched.kind) {
    case "down":
      return fetched.reason;
    case "denied":
      return SIGNED_OUT;
    case "answer": {
      const { httpStatus, body } = fetched;
      if (httpStatus !== 200) return body.error ?? "The update service did not switch the channel.";
      if (!body.reachable || !body.updater) return body.error ?? "The update service is not reachable.";
      if (body.updater.channel !== channel) return `The update service still uses the channel ${CHANNEL_LABELS[body.updater.channel]}.`;
      return null;
    }
  }
}

export function stageLabel(stage: InstallStage | undefined, running: string | null): string {
  switch (stage) {
    case "pulling":
      return "Downloading";
    case "starting":
      return "Starting";
    case "rolling-back":
      return running ? `Going back to ${running}` : "Going back";
    case "deploying":
      return "Deploying";
    default:
      return "Waiting for the server";
  }
}

const UNITS = [
  { ms: 86_400_000, one: "day", many: "days" },
  { ms: 3_600_000, one: "hour", many: "hours" },
  { ms: 60_000, one: "min", many: "min" },
] as const;

/** "5 min ago", "2 days ago", "just now". */
export function relativeTime(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return null;
  for (const unit of UNITS) {
    const count = Math.floor(elapsed / unit.ms);
    if (count >= 1) return `${count} ${count === 1 ? unit.one : unit.many} ago`;
  }
  return "just now";
}

/** When an update installs by itself; null when it does not. */
export function installsLine(update: Update, now: number, formatDateTime: (value: Date) => string): string | null {
  if (!update.installsAt) return null;
  const at = new Date(update.installsAt);
  if (Number.isNaN(at.getTime())) return null;
  return at.getTime() <= now ? "Installs automatically at the next check" : `Installs automatically on ${formatDateTime(at)}`;
}

/** The notes to list (at most 8) and how many changes are left over. */
export function visibleNotes(update: Update, max = 8): { notes: string[]; more: number } {
  const notes = update.notes.slice(0, max);
  return { notes, more: Math.max(update.changes, update.notes.length) - notes.length };
}

/** Only web links: the address comes from the updater. */
export function safeLink(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

const COOLDOWN_UNITS: Record<string, [string, string]> = {
  d: ["day", "days"],
  h: ["hour", "hours"],
  m: ["minute", "minutes"],
  s: ["second", "seconds"],
};

/** "3d" → "3 days", "12h" → "12 hours", "3600" → "3600 seconds"; null for none. */
export function formatCooldown(cooldown: string | null): string | null {
  if (!cooldown) return null;
  const match = /^(\d+)([dhms]?)$/.exec(cooldown.trim());
  if (!match) return cooldown;
  const count = Number(match[1]);
  if (count === 0) return null;
  const [one, many] = COOLDOWN_UNITS[match[2] || "s"]!;
  return `${count} ${count === 1 ? one : many}`;
}

/** The Stable option's description. */
export function stableDescription(cooldown: string | null): string {
  const after = formatCooldown(cooldown);
  return after
    ? `Releases. Updates that need no action install automatically after ${after}.`
    : "Releases. Updates that need no action install automatically.";
}

/** What installs by itself on this server, and when. */
export function automaticLine(status: Status): string {
  if (status.mode === "off" || !status.automatic) return "Off on this server: nothing installs automatically.";
  if (status.mode === "platform") return "The platform installs them (deploy link).";
  const after = formatCooldown(status.cooldown);
  const what =
    status.channel === "preview"
      ? "previews and releases install automatically within the hour"
      : after
        ? `releases install automatically after ${after}`
        : "releases install automatically within the hour";
  const [start, end] = status.window?.split("-") ?? [];
  const window = start && end ? `, between ${start} and ${end} (${status.timezone})` : "";
  return `On: ${what}${window}.`;
}
