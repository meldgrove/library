import type { ErrorEvent, EventHint, NodeOptions } from "@sentry/node";
import type { ErrorReportingConfig } from "./config";
import { databaseErrorSummary, type ErrorDetails } from "./db/error-summary";

function databaseSummaryFromCause(error: unknown): string | undefined {
  const seen = new Set<object>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const details = error as ErrorDetails;
    const summary = databaseErrorSummary(typeof details.message === "string" ? details.message : "", details);
    if (summary) return summary;
    error = details.cause;
  }
  return undefined;
}

/**
 * pg-boss emits some errors as plain objects that copy every property of the
 * original error, such as Drizzle's `params`. Keeps only message and stack.
 */
export function asError(error: unknown): unknown {
  if (error instanceof Error || typeof error !== "object" || error === null) return error;
  const { name, message, stack } = error as ErrorDetails;
  const summary = databaseSummaryFromCause(error);
  const converted = new Error(summary ?? String(message));
  if (typeof stack === "string") {
    if (summary) {
      // Replace the full original header, including any multiline message.
      const header = `${typeof name === "string" ? name : "Error"}: ${String(message)}`;
      if (stack.startsWith(`${header}\n    at `)) converted.stack = `Error: ${summary}${stack.slice(header.length)}`;
    } else {
      converted.stack = stack;
    }
  }
  return converted;
}

function redactEvent(event: ErrorEvent, hint: EventHint): ErrorEvent {
  const exceptions = event.exception?.values ?? [];
  const summary = databaseSummaryFromCause(hint.originalException)
    ?? exceptions.map(({ value }) => databaseErrorSummary(value ?? "")).find(Boolean)
    ?? databaseErrorSummary(event.message ?? "");
  if (!summary) return event;
  // Sentry can report linked causes as separate exceptions. Keep their
  // stack frames while replacing every message in the database error event.
  for (const exception of exceptions) exception.value = summary;
  if (event.message) event.message = summary;
  return event;
}

/**
 * Options for `Sentry.init` in the web process and the worker, or `undefined`
 * while error reporting is off. Errors only, without personal data: no
 * tracing, no user, cookies, headers, bodies, query strings, local variables,
 * or breadcrumbs (they repeat console output and outgoing URLs). The release
 * is SENTRY_RELEASE, else `library@<APP_VERSION>` in release images.
 */
export function sentryOptions(config: ErrorReportingConfig, service: "web" | "worker"): NodeOptions | undefined {
  if (!config.SENTRY_DSN) return undefined;
  return {
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT,
    release: config.SENTRY_RELEASE ?? (config.APP_VERSION ? `library@${config.APP_VERSION}` : undefined),
    initialScope: { tags: { service } },
    maxBreadcrumbs: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
    },
    beforeSend: redactEvent,
  };
}
