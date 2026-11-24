import * as Sentry from "@sentry/nextjs";

// Runs once when the server starts. Invalid configuration stops the process
// instead of failing later on the first request.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getErrorReportingConfig, validateWebConfig } = await import("@/lib/config");
    validateWebConfig();
    const { sentryOptions } = await import("@/lib/error-reporting");
    const options = sentryOptions(getErrorReportingConfig(), "web");
    if (options) Sentry.init(options);
    // Old variables (SLACK_SIGNING_SECRET) go into the database once; a
    // failure here must not keep the library from starting.
    const { importAtStart } = await import("@/lib/settings/legacy-env");
    const { getSettingsKey } = await import("@/lib/settings/secret-box");
    const { getDb } = await import("@/lib/db/client");
    const { logger } = await import("@/lib/logger");
    await importAtStart(getDb(), getSettingsKey(), "web").catch((error: unknown) => {
      logger.error({ err: error }, "old variables could not be copied into the database");
      Sentry.captureException(error);
    });
  }
}

// Errors in pages, Server Actions, and route handlers. Does nothing while
// error reporting is off.
export const onRequestError = Sentry.captureRequestError;
