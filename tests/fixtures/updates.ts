import type { Status, Update, UpdatesResponse } from "@/lib/updates/types";

/* Answers of Meldgrove Updater 0.2 for tests. */

export function release(version: string, extra: Partial<Update> = {}): Update {
  return {
    version,
    preview: false,
    publishedAt: "2026-11-17T08:00:00.000Z",
    url: `https://github.com/meldgrove/library/releases/tag/v${version}`,
    notes: ["Show who changed a note last", "Fix the sign-in loop behind some proxies"],
    changes: 2,
    installsAt: "2026-11-21T02:00:00.000Z",
    failed: null,
    ...extra,
  };
}

export function status(extra: Partial<Status> = {}): Status {
  return {
    updater: "0.2.0",
    mode: "host",
    channel: "stable",
    channelLocked: null,
    installed: "0.2.0",
    available: null,
    attention: null,
    installing: null,
    last: null,
    checking: false,
    checkedAt: "2026-11-19T09:55:00.000Z",
    error: null,
    automatic: true,
    cooldown: "3d",
    window: "02:00-05:00",
    timezone: "UTC",
    ...extra,
  };
}

export function answer(updater: Status | null, extra: Partial<UpdatesResponse> = {}): UpdatesResponse {
  return { app: { version: "0.2.0" }, reachable: updater !== null, updater, error: null, ...extra };
}
