/*
 * The HTTP API of Meldgrove Updater 0.2 and the library's answers to the
 * update button. Every Meldgrove app answers the same way; change them only
 * together with the updater. Used by the server and the browser: no imports.
 */

export const CHANNELS = ["stable", "preview"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = { stable: "Stable", preview: "Preview" };

/** A release (0.2.1) or a preview (0.2.1-preview.3). */
export const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-preview\.[0-9]+)?$/;
/** An image without a version, by the start of its digest. */
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{12}$/;

export function isInstallableVersion(value: unknown): value is string {
  return typeof value === "string" && (VERSION_PATTERN.test(value) || DIGEST_PATTERN.test(value));
}

/** Where the browser asks: the route handlers under src/app/api/admin/updates. */
export const UPDATES_API = "/api/admin/updates";

export interface Update {
  /** Or "sha256:<12 hex>" for an image without version. */
  version: string;
  preview: boolean;
  publishedAt: string | null;
  /** Release notes, or the compare view of a preview. */
  url: string | null;
  /** Change titles, newest release first, at most 15. */
  notes: string[];
  /** All changes, when more than `notes`. */
  changes: number;
  /** Automatic install time; null: not automatic. */
  installsAt: string | null;
  /** Message of an earlier failed installation. */
  failed: string | null;
}

export type InstallStage = "requested" | "pulling" | "starting" | "rolling-back" | "deploying";
export type InstallResult = "installed" | "failed" | "rolled-back" | "accepted";

export interface Status {
  updater: string;
  mode: "host" | "platform" | "off";
  channel: Channel;
  /** Why admins cannot switch; null: they can. */
  channelLocked: string | null;
  /** Null: unknown. */
  installed: string | null;
  available: Update | null;
  /** Needs upgrade steps; Stable only. */
  attention: Update | null;
  installing: {
    version: string;
    startedAt: string;
    manual: boolean;
    stage: InstallStage;
  } | null;
  last: {
    version: string;
    result: InstallResult;
    /** Why it failed, for admins. */
    message: string | null;
    finishedAt: string;
  } | null;
  checking: boolean;
  /** Last successful check. */
  checkedAt: string | null;
  /** Last check's error. */
  error: string | null;
  /** False in mode off. */
  automatic: boolean;
  /** E.g. "3d"; null: none. */
  cooldown: string | null;
  /** E.g. "02:00-05:00". */
  window: string | null;
  timezone: string;
}

/** What every route under UPDATES_API answers. */
export interface UpdatesResponse {
  /** APP_VERSION; null in development. */
  app: { version: string | null };
  /** False: no updater at UPDATER_URL. */
  reachable: boolean;
  updater: Status | null;
  /** Why the updater refused or could not be reached. */
  error: string | null;
}

export function isUpdatesResponse(value: unknown): value is UpdatesResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<UpdatesResponse>;
  return typeof candidate.reachable === "boolean" && typeof candidate.app === "object" && candidate.app !== null && "updater" in candidate;
}
