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
  /**
   * `installing.startedAt` once an answer reported the installation (the
   * updater's clock): with the version, the installation's identity.
   */
  startedAt: string | null;
  /** The `last` of the newest status when the attempt started (the earlier result): never this attempt's. */
  earlier: Status["last"];
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
  /** The last error while the page looked for it: of the install request, then of each status request. */
  error: string | null;
  /** A reachable status answered after the attempt started (without it, as long as it is not confirmed). */
  answered: boolean;
  /** No answer, a server error, or no updater at least once: the library or the updater restarted. */
  outage: boolean;
  /** The last request got no answer, or the updater did not answer. */
  restarting: boolean;
}

/** An installation an admin stopped waiting for: by its identity, or without one by its version and the attempt's start. */
export type Dismissed = Pick<InstallWait, "version" | "startedAt" | "since">;

export interface Failure {
  version: string;
  message: string | null;
  /** This page asked for the installation: its message opens by itself. */
  mine?: boolean;
}

/** An answer of the routes under /api/admin/updates. */
export type Fetched =
  | { kind: "answer"; httpStatus: number; body: UpdatesResponse }
  /**
   * No usable answer: a network error, a timeout, a server error, as while the
   * library restarts, or a body that cannot be read (with its HTTP status).
   */
  | { kind: "down"; reason: string; httpStatus?: number }
  /** 401, 403, 404, or the sign-in page (a redirect, or HTML instead of JSON): the session ended. */
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

/**
 * A failure from this page whose version the updater no longer offers while
 * it offers another: the offer shows, with the failure as a line in it.
 */
export function replacedFailure(failure: Failure | null, updater: Status | null): Failure | null {
  if (!failure || !updater) return null;
  const offered = [updater.available?.version, updater.attention?.version].filter((version) => version !== undefined);
  return offered.length > 0 && !offered.includes(failure.version) ? failure : null;
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
  if ((failure && !replacedFailure(failure, updater)) || reportedFailure(updater)) return "failed";
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

/** An attempt from this page, remembered before its install request, with the result known then. */
export function newAttempt(version: string, response: UpdatesResponse | null, now: number): InstallWait {
  return {
    version,
    from: response?.app.version ?? null,
    startedAt: null,
    earlier: response?.updater?.last ?? null,
    since: now,
    mine: true,
    confirmed: false,
    giveUpAt: null,
    reason: null,
    error: null,
    answered: false,
    outage: false,
    restarting: false,
  };
}

/** Follows an installation that an answer reports: another admin's, or an automatic one. */
export function startWait(version: string, response: UpdatesResponse, mine: boolean, now: number): InstallWait {
  const updater = response.updater;
  return {
    ...newAttempt(version, response, now),
    startedAt: updater?.installing?.version === version ? updater.installing.startedAt : null,
    mine,
    confirmed: true,
  };
}

/**
 * What the answer to an install request means for the attempt:
 *
 * - 202: the updater accepted it; follow it, also when the body cannot be read.
 * - Refused (4xx, or the session ended): forget it and show why, unless the
 *   answer reports another installation (another admin or an automatic
 *   install was faster): follow that one instead.
 * - Anything else (no answer, a timeout, a server error, an unreadable
 *   answer, or no updater): the request may have reached the updater. Keep
 *   the attempt and look for it until RECONCILE_MS after it started.
 */
export function afterInstallAnswer(attempt: InstallWait, fetched: Fetched, now: number): { wait: InstallWait | null; error: string | null } {
  if (fetched.kind === "denied") return { wait: null, error: SIGNED_OUT };
  const body = fetched.kind === "answer" ? fetched.body : null;
  const installing = body?.updater?.installing;
  if (fetched.httpStatus === 202) {
    return { wait: { ...attempt, confirmed: true, startedAt: installing?.version === attempt.version ? installing.startedAt : null }, error: null };
  }
  if (fetched.httpStatus !== undefined && fetched.httpStatus >= 400 && fetched.httpStatus < 500) {
    if (body && installing) return { wait: startWait(installing.version, body, installing.version === attempt.version, now), error: null };
    return { wait: null, error: (body ? body.error : fetched.kind === "down" ? fetched.reason : null) ?? "The update service did not accept the installation." };
  }
  const reason = fetched.kind === "down" ? fetched.reason : fetched.body.error;
  const outage = fetched.kind === "down" || !fetched.body.reachable;
  return { wait: { ...attempt, giveUpAt: attempt.since + RECONCILE_MS, reason, error: reason, outage, restarting: outage }, error: null };
}

/** Whole seconds, as the updater writes its times. */
function wholeSeconds(ms: number): number {
  return Math.floor(ms / 1_000) * 1_000;
}

function sameResult(a: Status["last"], b: Status["last"]): boolean {
  return !!a && !!b && a.version === b.version && a.result === b.result && a.finishedAt === b.finishedAt;
}

/**
 * The updater's result for the attempt, when it is fresh: for its version,
 * not the earlier result, and finished at or after the installation started:
 * `installing.startedAt` when an answer reported it, otherwise the attempt's
 * start cut to whole seconds (the updater writes whole seconds).
 */
export function attemptResult(wait: InstallWait, updater: Status | null): Status["last"] {
  const last = updater?.last;
  if (!last || last.version !== wait.version || sameResult(last, wait.earlier)) return null;
  const start = wait.startedAt === null ? wholeSeconds(wait.since) : Date.parse(wait.startedAt);
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
 * it cannot be asked (it restarts too), the page waits and counts an outage.
 * In this order:
 *
 * 1. a fresh result `failed` or `rolled-back` for the version: failed;
 * 2. the updater still installs the version: waiting, even when the library
 *    already answers with it (on a server the result comes only after every
 *    service is healthy, and it may still roll back);
 * 3. a fresh result `installed`: done;
 * 4. a fresh result `accepted` (platform): done once the library runs the
 *    version, or, without a version (development), once the updater answered
 *    after an outage;
 * 5. nothing reports the installation any more and the library runs the
 *    version: done.
 */
export function installOutcome(wait: InstallWait, response: UpdatesResponse): InstallOutcome {
  const updater = response.reachable ? response.updater : null;
  if (!updater) return { kind: "waiting", wait: { ...wait, outage: true, restarting: true, error: response.error ?? wait.error } };
  const current = { ...wait, answered: true, restarting: false };
  const last = attemptResult(wait, updater);
  const installing = updater.installing;
  const version = response.app.version;
  if (last?.result === "failed" || last?.result === "rolled-back") return { kind: "failed", message: last.message };
  if (installing?.version === wait.version) {
    return { kind: "waiting", wait: { ...current, confirmed: true, startedAt: current.startedAt ?? installing.startedAt } };
  }
  if (last?.result === "installed") return { kind: "done" };
  if (last?.result === "accepted") {
    if (version === wait.version || (version === null && wait.outage)) return { kind: "done" };
    return { kind: "waiting", wait: { ...current, confirmed: true } };
  }
  if (version !== null && version === wait.version) return { kind: "done" };
  if (installing) return { kind: "other" };
  return { kind: "waiting", wait: current };
}

/** An attempt with no clear answer that no status reported in time: the page stops looking for it. */
export function gaveUp(wait: InstallWait, now: number): boolean {
  return !wait.confirmed && wait.giveUpAt !== null && now >= wait.giveUpAt;
}

/**
 * Why the page stopped looking for an attempt at its deadline: the updater
 * answered without it, or it could not be asked.
 */
export function unconfirmedError(wait: InstallWait): { title: string; message: string } {
  const unreported = `The update service did not report an installation of ${wait.version}.`;
  return wait.answered
    ? { title: "The installation did not start", message: wait.reason ?? unreported }
    : { title: "The installation could not be confirmed", message: wait.error ?? unreported };
}

/** The identity to ignore after Stop waiting: kept on the attempt, so it works while the updater is unreachable. */
export function dismissal(wait: InstallWait): Dismissed {
  return { version: wait.version, startedAt: wait.startedAt, since: wait.since };
}

/** Whether a reported installation is the one an admin stopped waiting for. */
export function isDismissed(dismissed: Dismissed | null, installing: Status["installing"]): boolean {
  if (!dismissed || !installing || installing.version !== dismissed.version) return false;
  if (dismissed.startedAt !== null) return installing.startedAt === dismissed.startedAt;
  return Date.parse(installing.startedAt) >= wholeSeconds(dismissed.since);
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
