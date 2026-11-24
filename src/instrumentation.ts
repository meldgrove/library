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
    // The webhook's URL of 0.3.3 and 0.3.4; a failure here must not keep the
    // library from starting.
    const { sealWebhookUrl } = await import("@/lib/settings/service");
    const { getSettingsKey } = await import("@/lib/settings/secret-box");
    const { getDb } = await import("@/lib/db/client");
    const { logger } = await import("@/lib/logger");
    try {
      if (await sealWebhookUrl(getDb(), getSettingsKey()!)) logger.info("the webhook's URL is sealed in the database now");
    } catch (error) {
      logger.error({ err: error }, "the webhook's URL could not be sealed");
      Sentry.captureException(error);
    }
  }
}

// Errors in pages, Server Actions, and route handlers. Does nothing while
// error reporting is off.
export const onRequestError = Sentry.captureRequestError;
