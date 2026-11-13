import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Slack signs every request to the Events API: `v0=` and the hex HMAC-SHA256,
 * keyed with the app's signing secret, of `v0:{timestamp}:{raw body}`. A
 * request older than five minutes is refused, so a recorded one cannot be
 * replayed later. Pure function.
 */

/** How far the request's timestamp may be from now. */
export const SLACK_SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

export interface SlackSignatureInput {
  signingSecret: string;
  /** The `X-Slack-Signature` header. */
  signature: string | null;
  /** The `X-Slack-Request-Timestamp` header, in seconds. */
  timestamp: string | null;
  /** The body exactly as received. */
  body: string;
  now?: Date;
}

export function slackSignature(signingSecret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

/** True when Slack signed this request within the last five minutes. */
export function verifySlackSignature(input: SlackSignatureInput): boolean {
  if (!input.signature || !input.timestamp || !/^\d{1,12}$/.test(input.timestamp)) return false;
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - Number(input.timestamp)) > SLACK_SIGNATURE_MAX_AGE_SECONDS) return false;
  const expected = Buffer.from(slackSignature(input.signingSecret, input.timestamp, input.body));
  const given = Buffer.from(input.signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
