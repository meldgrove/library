import { NextResponse } from "next/server";
import { getSlackIntakeConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { readSlackRequest, recordSlackEvent } from "@/lib/library/slack-intake";
import { verifySlackSignature } from "@/lib/slack/signature";

/*
 * Slack's Events API (subscription `message.im`). No session: Slack signs
 * each request with the app's signing secret, and only signed requests from
 * the last five minutes count. Messages are stored for the worker, so Slack
 * gets its answer within three seconds; nothing is downloaded here.
 */

/** Events are small; a larger body is not from Slack. */
const MAX_BODY_BYTES = 256 * 1_024;

/** The body as text, or null when it is larger than the limit (whether or not it declares its length). */
async function readBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(request: Request) {
  const signingSecret = getSlackIntakeConfig().SLACK_SIGNING_SECRET;
  // The Slack bot is off.
  if (!signingSecret) return new Response(null, { status: 404 });
  const body = await readBody(request);
  if (body === null) return new Response(null, { status: 413 });
  const signed = verifySlackSignature({
    signingSecret,
    signature: request.headers.get("x-slack-signature"),
    timestamp: request.headers.get("x-slack-request-timestamp"),
    body,
  });
  if (!signed) return new Response(null, { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response(null, { status: 400 });
  }
  const slackRequest = readSlackRequest(payload);
  if (slackRequest.kind === "challenge") return NextResponse.json({ challenge: slackRequest.challenge });
  // Slack retries an event it got no answer for; the event ID records it once.
  if (slackRequest.kind === "message") await recordSlackEvent(getDb(), slackRequest.event);
  return new Response(null, { status: 200 });
}
