import type { InstallStage, Status, Update, UpdatesResponse } from "./types";

/*
 * What the update button and the admin page show, derived from an answer of
 * /api/admin/updates. Pure functions, so that each state can be tested.
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

/** An installation the page waits for: it reloads once the new version runs. */
export interface InstallWait {
  version: string;
  /** The library's version when the installation started (null in development). */
  from: string | null;
  /** When the updater started it (its clock), to tell its result from earlier ones. */
  requestedAt: string | null;
  /** When the page started waiting (the browser's clock, ms). */
  since: number;
  /** Started from this page, not by the updater or another admin. */
  mine: boolean;
  /** The library did not answer at least once: it restarted. */
  outage: boolean;
  /** The last request got no answer. */
  restarting: boolean;
}

export interface Failure {
  version: string;
  message: string | null;
}

/** After this long without a result, the button says to check the server. */
export const SLOW_INSTALL_MS = 15 * 60_000;

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

/** The version being installed. */
export function installingVersion(response: UpdatesResponse | null, wait: InstallWait | null): string | null {
  return wait?.version ?? response?.updater?.installing?.version ?? null;
}

/** The version that runs now, as far as anyone knows. */
export function runningVersion(response: UpdatesResponse | null): string | null {
  return response?.updater?.installed ?? response?.app.version ?? null;
}

/**
 * Whether the installation a page waits for is over:
 *
 * - done when the library runs the version, or the updater installed it and
 *   the library changed (another version, or it restarted; in development it
 *   has no version to compare), or the platform accepted it and the library
 *   changed;
 * - failed when the updater says it failed or rolled back;
 * - gone when the updater installs nothing and has no result for it.
 */
export function installOutcome(wait: InstallWait, response: UpdatesResponse): "done" | "failed" | "gone" | "waiting" {
  const version = response.app.version;
  if (version !== null && version === wait.version) return "done";
  const updater = response.updater;
  const last = updater?.last;
  const ended = last && last.version === wait.version && !(wait.requestedAt && Date.parse(last.finishedAt) < Date.parse(wait.requestedAt));
  if (!last || !ended) return response.reachable && updater && !updater.installing ? "gone" : "waiting";
  const changed = version !== wait.from || wait.outage;
  switch (last.result) {
    case "failed":
    case "rolled-back":
      return "failed";
    case "installed":
      return changed || version === null ? "done" : "waiting";
    case "accepted":
      return changed ? "done" : "waiting";
  }
}

/** Starts waiting for an installation the updater accepted or reports. */
export function startWait(version: string, response: UpdatesResponse, mine: boolean, now: number): InstallWait {
  const updater = response.updater;
  const requestedAt =
    updater?.installing?.version === version
      ? updater.installing.startedAt
      : updater?.last?.version === version
        ? updater.last.finishedAt
        : null;
  return { version, from: response.app.version, requestedAt, since: now, mine, outage: false, restarting: false };
}

export function isSlow(wait: InstallWait, now: number): boolean {
  return now - wait.since > SLOW_INSTALL_MS;
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
