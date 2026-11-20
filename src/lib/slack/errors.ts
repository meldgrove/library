/*
 * Which failed Slack Web API calls may pass. The notification transport and
 * the bot's client both decide with these, so they retry the same answers.
 * A permanent error (a bad token, a missing scope) stays until someone
 * changes the Slack app.
 */

/** Slack error codes that may pass. Every other one is permanent. */
const TEMPORARY_ERRORS = new Set(["ratelimited", "rate_limited", "internal_error", "fatal_error", "service_unavailable", "request_timeout"]);

/** An HTTP error other than a timeout (408), a rate limit (429), or a server error (5xx). */
export function isPermanentSlackStatus(status: number): boolean {
  return status !== 408 && status !== 429 && status < 500;
}

/**
 * An error code that Slack does not list as temporary. An answer without a
 * code is not one of Slack's (a proxy, an outage page) and may pass, as does
 * an answer that cannot be read.
 */
export function isPermanentSlackError(error: string | undefined): boolean {
  return error !== undefined && !TEMPORARY_ERRORS.has(error);
}
