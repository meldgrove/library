import { z } from "zod";
import { getUpdaterConfig, getVersionConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { CHANNELS, type Status, type UpdatesResponse } from "./types";

/*
 * The client of the Meldgrove Updater's HTTP API (the `updater` service of
 * compose.yaml). The updater has no authentication and is reached only from
 * the server; the browser asks the admin-only routes under /api/admin/updates.
 *
 * An updater that cannot be reached, such as updater 0.1, which has no HTTP
 * API, is an answer too: `reachable: false`, and the update button says so.
 */

/** How long each call may take: checks contact the registry and GitHub. */
export const UPDATER_TIMEOUTS = { status: 3_000, check: 35_000, install: 10_000, channel: 35_000 } as const;

export interface UpdaterCall {
  method: "GET" | "POST";
  path: "/v1/status" | "/v1/check" | "/v1/install" | "/v1/channel";
  body?: Record<string, unknown>;
  timeoutMs: number;
}

/** An answer for the browser and its HTTP status. */
export interface UpdatesResult {
  httpStatus: number;
  body: UpdatesResponse;
}

const STATUS_CALL: UpdaterCall = { method: "GET", path: "/v1/status", timeoutMs: UPDATER_TIMEOUTS.status };

const nullableString = z.string().nullable();

const updateSchema = z.object({
  version: z.string().min(1),
  preview: z.boolean(),
  publishedAt: nullableString,
  url: nullableString,
  notes: z.array(z.string()),
  changes: z.number().int().nonnegative(),
  installsAt: nullableString,
  failed: nullableString,
});

const statusSchema: z.ZodType<Status> = z.object({
  updater: z.string(),
  mode: z.enum(["host", "platform", "off"]),
  channel: z.enum(CHANNELS),
  channelLocked: nullableString,
  installed: nullableString,
  available: updateSchema.nullable(),
  attention: updateSchema.nullable(),
  installing: z
    .object({
      version: z.string(),
      startedAt: z.string(),
      manual: z.boolean(),
      stage: z.enum(["requested", "pulling", "starting", "rolling-back", "deploying"]),
    })
    .nullable(),
  last: z
    .object({
      version: z.string(),
      result: z.enum(["installed", "failed", "rolled-back", "accepted"]),
      message: nullableString,
      finishedAt: z.string(),
    })
    .nullable(),
  checking: z.boolean(),
  checkedAt: nullableString,
  error: nullableString,
  automatic: z.boolean(),
  cooldown: nullableString,
  window: nullableString,
  timezone: z.string(),
});

const errorSchema = z.object({ error: z.string().min(1) });

type Answer =
  | { kind: "status"; httpStatus: number; status: Status }
  | { kind: "refused"; httpStatus: number; error: string }
  | { kind: "unreachable"; error: string };

const NETWORK_ERRORS: Record<string, string> = {
  ECONNREFUSED: "connection refused",
  ECONNRESET: "connection reset",
  ENOTFOUND: "unknown host",
  EAI_AGAIN: "unknown host",
  EHOSTUNREACH: "host unreachable",
  ENETUNREACH: "network unreachable",
};

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** Why a request did not get an answer, in a few words. */
function networkReason(error: unknown): string {
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  if (code) return NETWORK_ERRORS[code] ?? code;
  return error instanceof Error ? error.message : String(error);
}

async function ask(baseUrl: string, call: UpdaterCall): Promise<Answer> {
  const seconds = call.timeoutMs / 1_000;
  let response: Response;
  let payload: unknown;
  try {
    response = await fetch(`${baseUrl}${call.path}`, {
      method: call.method,
      headers: call.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      signal: AbortSignal.timeout(call.timeoutMs),
      cache: "no-store",
      redirect: "error",
    });
    payload = await response.json().catch((error: unknown) => {
      if (isTimeout(error)) throw error;
      return undefined;
    });
  } catch (error) {
    if (isTimeout(error)) return { kind: "unreachable", error: `The update service at ${baseUrl} did not answer within ${seconds} seconds.` };
    return { kind: "unreachable", error: `The update service at ${baseUrl} is not reachable (${networkReason(error)}).` };
  }
  if (response.ok) {
    const parsed = statusSchema.safeParse(payload);
    if (parsed.success) return { kind: "status", httpStatus: response.status, status: parsed.data };
  } else if (response.status >= 400 && response.status < 600) {
    const parsed = errorSchema.safeParse(payload);
    if (parsed.success) return { kind: "refused", httpStatus: response.status, error: parsed.data.error };
  }
  return {
    kind: "unreachable",
    error: `The service at ${baseUrl} is not Meldgrove Updater 0.2 or later: ${call.method} ${call.path} answered HTTP ${response.status}.`,
  };
}

function appVersion(): UpdatesResponse["app"] {
  return { version: getVersionConfig().APP_VERSION ?? null };
}

/**
 * Calls the updater and turns its answer into the library's:
 *
 * - a status: 200, or 202 for an accepted installation;
 * - an error answer of the updater: 409 with its `error` and the latest status,
 *   except a server error (5xx) of an install, which keeps its status code:
 *   the browser cannot tell whether that installation started, and looks for
 *   it, while it takes a 4xx as a refusal;
 * - no updater (connection failure, timeout, another service, or an empty
 *   UPDATER_URL): 200 with `reachable: false`.
 */
export async function callUpdater(call: UpdaterCall): Promise<UpdatesResult> {
  const app = appVersion();
  const baseUrl = getUpdaterConfig().UPDATER_URL;
  if (baseUrl === null) {
    return { httpStatus: 200, body: { app, reachable: false, updater: null, error: "UPDATER_URL is empty, so the update service is off." } };
  }
  const answer = await ask(baseUrl, call);
  switch (answer.kind) {
    case "status":
      return { httpStatus: answer.httpStatus === 202 ? 202 : 200, body: { app, reachable: true, updater: answer.status, error: null } };
    case "unreachable":
      logger.warn({ path: call.path, error: answer.error }, "update service not reachable");
      return { httpStatus: 200, body: { app, reachable: false, updater: null, error: answer.error } };
    case "refused": {
      const latest = call.path === STATUS_CALL.path ? null : await ask(baseUrl, STATUS_CALL);
      const serverError = call.path === "/v1/install" && answer.httpStatus >= 500;
      return {
        httpStatus: serverError ? answer.httpStatus : 409,
        body: { app, reachable: true, updater: latest?.kind === "status" ? latest.status : null, error: answer.error },
      };
    }
  }
}

/** The latest status with the library's own refusal, e.g. of an invalid request. */
export async function refuseWithStatus(httpStatus: number, error: string): Promise<UpdatesResult> {
  const { body } = await callUpdater(STATUS_CALL);
  return { httpStatus, body: { ...body, error } };
}

export const updaterCalls = {
  status: (): UpdaterCall => STATUS_CALL,
  check: (): UpdaterCall => ({ method: "POST", path: "/v1/check", timeoutMs: UPDATER_TIMEOUTS.check }),
  install: (version: string): UpdaterCall => ({ method: "POST", path: "/v1/install", body: { version }, timeoutMs: UPDATER_TIMEOUTS.install }),
  channel: (channel: string): UpdaterCall => ({ method: "POST", path: "/v1/channel", body: { channel }, timeoutMs: UPDATER_TIMEOUTS.channel }),
};
