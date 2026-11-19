import type { ErrorEvent } from "@sentry/node";
import { describe, expect, it } from "vitest";
import { parseErrorReportingConfig } from "./config";
import { asError, sentryOptions } from "./error-reporting";

const dsn = "https://key@o1.ingest.example.org/2";

describe("sentryOptions", () => {
  it("is off without a DSN", () => {
    expect(sentryOptions({}, "web")).toBeUndefined();
  });

  it("names the release after APP_VERSION unless SENTRY_RELEASE is set", () => {
    expect(sentryOptions({ SENTRY_DSN: dsn, APP_VERSION: "1.2.3" }, "web")?.release).toBe("library@1.2.3");
    expect(sentryOptions({ SENTRY_DSN: dsn, APP_VERSION: "1.2.3", SENTRY_RELEASE: "abc123" }, "web")?.release).toBe("abc123");
    expect(sentryOptions({ SENTRY_DSN: dsn }, "web")?.release).toBeUndefined();
    // Compose passes an unset SENTRY_RELEASE as "".
    const config = parseErrorReportingConfig({ SENTRY_DSN: dsn, SENTRY_RELEASE: "", APP_VERSION: "1.2.3" });
    expect(sentryOptions(config, "web")?.release).toBe("library@1.2.3");
  });

  it("reports errors only, without personal data", () => {
    const options = sentryOptions({ SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: "staging", SENTRY_RELEASE: "abc123" }, "worker");
    expect(options).toMatchObject({
      dsn,
      environment: "staging",
      release: "abc123",
      initialScope: { tags: { service: "worker" } },
      maxBreadcrumbs: 0,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        databaseQueryData: false,
        stackFrameVariables: false,
      },
    });
    expect(options?.tracesSampleRate).toBeUndefined();
  });

  it("replaces database exception messages, including linked PostgreSQL errors", () => {
    const beforeSend = sentryOptions({ SENTRY_DSN: dsn }, "web")?.beforeSend;
    const postgres = Object.assign(new Error('invalid input syntax for uuid: "example-session-token"'), { severity: "ERROR", code: "22P02" });
    const drizzle = new Error('Failed query: select token from auth_session where token = $1\nparams: example-session-token', { cause: postgres });
    const stacktrace = { frames: [{ filename: "session.ts", lineno: 31 }] };
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [
          { type: "error", value: postgres.message },
          { type: "Error", value: drizzle.message, stacktrace },
        ],
      },
    };
    const sent = beforeSend?.(event, { originalException: drizzle }) as ErrorEvent;
    expect(sent.exception?.values).toEqual([
      { type: "error", value: "Database query failed (PostgreSQL 22P02)" },
      { type: "Error", value: "Database query failed (PostgreSQL 22P02)", stacktrace },
    ]);
  });

  it("preserves ordinary errors and recognizes query errors without a capture hint", () => {
    const beforeSend = sentryOptions({ SENTRY_DSN: dsn }, "web")?.beforeSend;
    const ordinary: ErrorEvent = { type: undefined, message: "connect ECONNREFUSED 127.0.0.1:5432" };
    expect(beforeSend?.(ordinary, {})).toBe(ordinary);
    const query: ErrorEvent = { type: undefined, message: "Failed query: select 1\nparams: a\nb" };
    expect(beforeSend?.(query, {})).toMatchObject({ message: "Database query failed" });
  });

  it("omits echoed values from a direct PostgreSQL error", () => {
    const beforeSend = sentryOptions({ SENTRY_DSN: dsn }, "worker")?.beforeSend;
    const error = Object.assign(new Error("invalid input: example-value"), { severity: "ERROR", code: "22P02" });
    const event: ErrorEvent = { type: undefined, exception: { values: [{ type: "error", value: error.message }] } };
    expect(beforeSend?.(event, { originalException: error })).toMatchObject({
      exception: { values: [{ value: "PostgreSQL error (22P02)" }] },
    });
  });
});
describe("asError", () => {
  it("replaces query inputs while converting a plain pg-boss error", () => {
    const original = Object.assign(new Error("Failed query: select 1\nparams: erika@example.org"), { params: ["erika@example.org"] });
    const emitted = { ...original, message: original.message, stack: original.stack, queue: "reminders" };
    const error = asError(emitted);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "Database query failed", stack: expect.stringContaining("\n    at ") });
    expect((error as Error).stack).not.toContain("erika@example.org");
    expect(Object.keys(error as Error)).toEqual([]);
  });

  it("redacts direct PostgreSQL errors after pg-boss copies them to plain objects", () => {
    const original = Object.assign(new Error("invalid input: example-value"), { name: "error", severity: "ERROR", code: "22P02" });
    const emitted = { ...original, message: original.message, stack: original.stack, worker: "example-worker" };
    const error = asError(emitted) as Error;
    const beforeSend = sentryOptions({ SENTRY_DSN: dsn }, "worker")?.beforeSend;
    const event: ErrorEvent = { type: undefined, exception: { values: [{ type: error.name, value: error.message }] } };
    expect(beforeSend?.(event, { originalException: error })).toMatchObject({
      exception: { values: [{ value: "PostgreSQL error (22P02)" }] },
    });
    expect(error.stack).not.toContain("example-value");
  });

  it("leaves errors as they are", () => {
    const error = new Error("boom");
    expect(asError(error)).toBe(error);
  });
});
