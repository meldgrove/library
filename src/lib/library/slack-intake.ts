import { and, asc, desc, eq, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { CommandError } from "@/lib/commands";
import type { Database, Transaction } from "@/lib/db/client";
import { person, slackEvent } from "@/lib/db/schema";
import { errorMessage, logger } from "@/lib/logger";
import type { NotificationMessage } from "@/lib/notifications/types";
import { consumeRateLimit, RateLimitError, WRITE_LIMIT } from "@/lib/rate-limit";
import { SlackApiError, type SlackIntakeClient } from "@/lib/slack/client";
import type { Storage } from "@/lib/storage";
import type { SlackMessage, SlackSharedFile } from "./constants";
import { LinkError } from "./fetch-link";
import { ACCEPTED_LABELS, looksAccepted } from "./file-types";
import { notifyPerson, postToChannel } from "./notify";
import { submitFile, submitLink } from "./submissions";

/*
 * The Slack bot. Staff send it a direct message with a link or a file and one
 * line on why. The web process checks Slack's signature and stores the
 * message (`recordSlackEvent`); it downloads nothing, so Slack gets its answer
 * within its three seconds. The worker then finds the person by the Slack
 * user's email address, downloads the files, submits each link and file, and
 * answers in the direct message through a notification row.
 *
 * People without access, and Slack users the library does not know, get one
 * fixed answer and no library data.
 */

/** At most this many links and files per message. */
const MAX_ITEMS = 10;
/** Shortest reason, as on the upload page. */
const MIN_REASON = 3;
const MAX_TEXT = 4_000;
/** Waits after the 1st, 2nd, 3rd, and 4th failed attempt (Slack down, a temporary error). */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
/** A message left in "processing" this long (a stopped worker) is taken up again. */
const STALE_PROCESSING_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Slack's markup (pure)
// ---------------------------------------------------------------------------

const decodeEntities = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Markup Slack puts in `<…>`: links, mentions, channels, and special words. */
const MARKUP = /<([^<>]*)>/g;

/**
 * The web links of a message and the reason: the text without the links.
 * Slack writes links as `<https://…>` or `<https://…|label>`; mentions of
 * people (`<@U…>`) and special words (`<!here>`) are dropped, channels
 * (`<#C…|name>`) become `#name`.
 */
export function parseSlackText(text: string): { links: string[]; reason: string } {
  const links: string[] = [];
  const rest = text.replace(MARKUP, (_, inner: string) => {
    const [target = "", label] = inner.split("|", 2) as [string, string | undefined];
    if (/^https?:\/\//i.test(target)) {
      const url = decodeEntities(target);
      if (!links.includes(url)) links.push(url);
      return " ";
    }
    if (target.startsWith("#")) return label ? `#${label}` : " ";
    if (target.startsWith("mailto:")) return label ?? target.slice("mailto:".length);
    return " ";
  });
  const reason = decodeEntities(rest)
    .replace(/\s+/g, " ")
    .trim()
    // What only joined the link to the reason: "<link> - why", "why: <link>".
    .replace(/^[\s\-–—:;,.|]+|[\s\-–—:;,|]+$/g, "")
    .trim();
  return { links, reason };
}

// ---------------------------------------------------------------------------
// The Events API request (pure)
// ---------------------------------------------------------------------------

const fileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  title: z.string().optional(),
  mimetype: z.string().optional(),
  size: z.number().optional(),
  url_private_download: z.string().optional(),
  mode: z.string().optional(),
});

const envelopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url_verification"), challenge: z.string().max(500) }),
  z.object({
    type: z.literal("event_callback"),
    event_id: z.string().min(1).max(100),
    event: z.object({
      type: z.string(),
      channel_type: z.string().optional(),
      subtype: z.string().optional(),
      bot_id: z.string().optional(),
      user: z.string().optional(),
      channel: z.string().optional(),
      text: z.string().optional(),
      ts: z.string().optional(),
      files: z.array(fileSchema).optional(),
    }),
  }),
]);

export interface SlackDirectMessage {
  eventId: string;
  slackUserId: string;
  channelId: string;
  message: SlackMessage;
}

export type SlackRequest = { kind: "challenge"; challenge: string } | { kind: "message"; event: SlackDirectMessage } | { kind: "ignored" };

/**
 * What a signed request from Slack asks for: the URL check when the Events
 * subscription is set up, a direct message to the bot from a person (no bot,
 * no edit or deletion), or nothing the library acts on.
 */
export function readSlackRequest(payload: unknown): SlackRequest {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) return { kind: "ignored" };
  if (parsed.data.type === "url_verification") return { kind: "challenge", challenge: parsed.data.challenge };
  const { event, event_id: eventId } = parsed.data;
  const fromPerson = !event.bot_id && (event.subtype === undefined || event.subtype === "file_share");
  if (event.type !== "message" || event.channel_type !== "im" || !fromPerson) return { kind: "ignored" };
  if (!event.user || !/^[UW][A-Z0-9]+$/.test(event.user) || !event.channel || !/^D[A-Z0-9]+$/.test(event.channel)) return { kind: "ignored" };
  const files: SlackSharedFile[] = (event.files ?? []).slice(0, MAX_ITEMS * 2).map((file) => ({
    id: file.id,
    name: (file.name ?? file.title ?? "file").slice(0, 200),
    mimetype: file.mimetype,
    size: file.size,
    urlPrivateDownload: file.url_private_download,
    mode: file.mode,
  }));
  return {
    kind: "message",
    event: { eventId, slackUserId: event.user, channelId: event.channel, message: { text: (event.text ?? "").slice(0, MAX_TEXT), ts: event.ts ?? "", files } },
  };
}

/** Stores a direct message for the worker. Slack's retries of the same event are ignored; returns false for them. */
export async function recordSlackEvent(db: Database, event: SlackDirectMessage): Promise<boolean> {
  const inserted = await db
    .insert(slackEvent)
    // Due by the worker's clock, not the database's: the two may differ by a moment.
    .values({ eventId: event.eventId, slackUserId: event.slackUserId, channelId: event.channelId, message: event.message, nextAttemptAt: new Date() })
    .onConflictDoNothing({ target: slackEvent.eventId })
    .returning({ eventId: slackEvent.eventId });
  return inserted.length > 0;
}

// ---------------------------------------------------------------------------
// The worker's step
// ---------------------------------------------------------------------------

export interface SlackIntakeDeps {
  db: Database;
  storage: Storage;
  slack: SlackIntakeClient;
  maxBytes: number;
}

export type SlackIntakeOutcome = "added" | "refused" | "no_reason" | "nothing_to_add" | "rate_limited" | "no_access" | "retry" | "failed" | "taken_over";

type Claimed = typeof slackEvent.$inferSelect;

async function claimNext(db: Database, now: Date): Promise<Claimed | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(slackEvent)
      .where(
        or(
          and(eq(slackEvent.status, "received"), lte(slackEvent.nextAttemptAt, now)),
          and(eq(slackEvent.status, "processing"), lte(slackEvent.nextAttemptAt, new Date(now.getTime() - STALE_PROCESSING_MS))),
        ),
      )
      .orderBy(asc(slackEvent.nextAttemptAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;
    const attempts = row.attempts + 1;
    await tx.update(slackEvent).set({ status: "processing", attempts, nextAttemptAt: now }).where(eq(slackEvent.eventId, row.eventId));
    return { ...row, attempts };
  });
}

/** The person with access behind an email address, if any. */
async function personWithAccess(db: Database, email: string) {
  const [row] = await db
    .select({ id: person.id, hasAccess: person.hasAccess })
    .from(person)
    .where(sql`lower(${person.workEmail}) = ${email.toLowerCase()}`)
    .orderBy(desc(person.hasAccess))
    .limit(1);
  return row?.hasAccess ? row : undefined;
}

/** The answer to Slack users without access: no library data, only where to turn. */
const NO_ACCESS: NotificationMessage = {
  subject: "Library",
  title: "Library",
  text: "The library could not take your message: your Slack account does not belong to anyone with access to the library. If you should have access, ask a library steward.",
  path: "/",
};

const replyTo = (eventId: string, recipientId: string, text: string) => ({
  event: "intake_reply" as const,
  subjectKey: `slack:${eventId}`,
  recipientId,
  channel: "slack" as const,
  message: { subject: "Your message to the library", title: "Your uploads", text, path: "/uploads" },
});

class TakenOver extends Error {}

/**
 * Locks the event and checks this worker's claim is still its own: a worker
 * that took longer than the stale threshold may have lost it to another.
 */
async function keepClaim(tx: Transaction, row: Claimed): Promise<void> {
  const [current] = await tx.select({ status: slackEvent.status, attempts: slackEvent.attempts }).from(slackEvent).where(eq(slackEvent.eventId, row.eventId)).for("update");
  if (!current || current.status !== "processing" || current.attempts !== row.attempts) throw new TakenOver();
}

async function finish(tx: Database | Transaction, eventId: string, outcome: SlackIntakeOutcome, personId: string | null, now: Date) {
  await tx
    .update(slackEvent)
    .set({ status: "done", outcome, personId, processedAt: now, lastError: null })
    .where(eq(slackEvent.eventId, eventId));
}

/** One line per item that was not added: "photo.png: The library takes …". */
const notAdded = (refusals: string[]) => refusals.map((line) => `• ${line}`).join("\n");

async function handle(deps: SlackIntakeDeps, row: Claimed, now: Date): Promise<SlackIntakeOutcome> {
  const { db } = deps;
  const email = await deps.slack.userEmail(row.slackUserId);
  const sender = email ? await personWithAccess(db, email) : undefined;
  if (!sender) {
    await db.transaction(async (tx) => {
      await keepClaim(tx, row);
      await postToChannel(tx, { event: "intake_no_access", key: row.eventId, channelId: row.channelId, message: NO_ACCESS });
      await finish(tx, row.eventId, "no_access", null, now);
    });
    return "no_access";
  }

  const answer = async (outcome: SlackIntakeOutcome, text: string) => {
    await db.transaction(async (tx) => {
      await keepClaim(tx, row);
      await notifyPerson(tx, replyTo(row.eventId, sender.id, text));
      await finish(tx, row.eventId, outcome, sender.id, now);
    });
    return outcome;
  };

  const { links, reason } = parseSlackText(row.message.text);
  const files = row.message.files.filter((file) => file.mode !== "tombstone");
  if (links.length === 0 && files.length === 0) {
    return answer("nothing_to_add", "Send a link or a file, with one line on why it is useful, and the library drafts a note from it.");
  }
  if (reason.length < MIN_REASON) {
    return answer("no_reason", "Add one line on why this is useful, then send the link or the file again with it.");
  }
  try {
    await consumeRateLimit(db, `write:${sender.id}`, WRITE_LIMIT, now);
  } catch (error) {
    if (error instanceof RateLimitError) return answer("rate_limited", error.message);
    throw error;
  }

  // Downloads happen before the transaction; a file that cannot be had is reported, not retried.
  const refusals: string[] = [];
  const downloaded: { file: SlackSharedFile; bytes: Uint8Array }[] = [];
  for (const [index, file] of files.entries()) {
    if (index >= MAX_ITEMS) {
      refusals.push(`${file.name}: The library takes at most ${MAX_ITEMS} files per message.`);
      continue;
    }
    if (file.mode === "external" || !file.urlPrivateDownload) {
      refusals.push(`${file.name}: this file is not stored in Slack. Send it as a link instead.`);
      continue;
    }
    if (!looksAccepted(file.name, file.mimetype)) {
      refusals.push(`${file.name}: The library takes ${ACCEPTED_LABELS} files.`);
      continue;
    }
    if (file.size !== undefined && file.size > deps.maxBytes) {
      refusals.push(`${file.name}: the file is larger than ${Math.round(deps.maxBytes / 1_048_576)} MB.`);
      continue;
    }
    try {
      downloaded.push({ file, bytes: await deps.slack.downloadFile({ url: file.urlPrivateDownload, mimetype: file.mimetype }, deps.maxBytes) });
    } catch (error) {
      if (!(error instanceof LinkError)) throw error;
      refusals.push(`${file.name}: ${error.message}`);
    }
  }

  return db.transaction(async (tx) => {
    await keepClaim(tx, row);
    let added = 0;
    const base = { submitterId: sender.id, channel: "slack" as const, reason };
    for (const [index, link] of links.entries()) {
      if (index >= MAX_ITEMS) {
        refusals.push(`${link}: The library takes at most ${MAX_ITEMS} links per message.`);
        continue;
      }
      try {
        await submitLink(tx, { ...base, url: link });
        added += 1;
      } catch (error) {
        if (!(error instanceof CommandError)) throw error;
        refusals.push(`${link}: ${error.message}`);
      }
    }
    for (const { file, bytes } of downloaded) {
      try {
        await submitFile(tx, deps.storage, { ...base, fileName: file.name, declaredMimeType: file.mimetype, bytes }, deps.maxBytes);
        added += 1;
      } catch (error) {
        if (!(error instanceof CommandError)) throw error;
        refusals.push(`${file.name}: ${error.message}`);
      }
    }
    const outcome: SlackIntakeOutcome = added > 0 ? "added" : "refused";
    const text =
      added > 0
        ? [`Added to the library: ${added === 1 ? "1 upload" : `${added} uploads`}. The AI draft follows here when it is ready.`, ...(refusals.length > 0 ? ["Not added:", notAdded(refusals)] : [])].join("\n")
        : ["Nothing was added:", notAdded(refusals)].join("\n");
    await notifyPerson(tx, replyTo(row.eventId, sender.id, text));
    await finish(tx, row.eventId, outcome, sender.id, now);
    return outcome;
  });
}

/** Handles the next stored Slack message, if one is due. Returns null when none is. */
export async function processNextSlackEvent(deps: SlackIntakeDeps, now: Date = new Date()): Promise<SlackIntakeOutcome | null> {
  const claimed = await claimNext(deps.db, now);
  if (!claimed) return null;
  try {
    return await handle(deps, claimed, now);
  } catch (error) {
    // Another worker took the message over: it writes the outcome, not this one.
    if (error instanceof TakenOver) {
      logger.warn({ eventId: claimed.eventId }, "Slack message was taken over by another worker");
      return "taken_over";
    }
    const message = errorMessage(error).slice(0, 1_000);
    const permanent = error instanceof SlackApiError && error.permanent;
    // Only while the claim is still this worker's: another may have taken the message over meanwhile.
    const stillClaimed = and(eq(slackEvent.eventId, claimed.eventId), eq(slackEvent.status, "processing"), eq(slackEvent.attempts, claimed.attempts));
    if (permanent || claimed.attempts >= MAX_ATTEMPTS) {
      const failed = await deps.db.update(slackEvent).set({ status: "failed", lastError: message, processedAt: now }).where(stillClaimed).returning({ eventId: slackEvent.eventId });
      if (failed.length === 0) return "taken_over";
      logger.error({ eventId: claimed.eventId, error: message }, "Slack message could not be handled");
      return "failed";
    }
    const wait = BACKOFF_MS[claimed.attempts - 1] ?? BACKOFF_MS.at(-1)!;
    const retried = await deps.db
      .update(slackEvent)
      .set({ status: "received", lastError: message, nextAttemptAt: new Date(now.getTime() + wait) })
      .where(stillClaimed)
      .returning({ eventId: slackEvent.eventId });
    if (retried.length === 0) return "taken_over";
    logger.warn({ eventId: claimed.eventId, attempts: claimed.attempts, error: message }, "Slack message will be retried");
    return "retry";
  }
}

/** Handles due Slack messages until none is left or `limit` is reached. */
export async function processDueSlackEvents(deps: SlackIntakeDeps, limit = 20): Promise<Partial<Record<SlackIntakeOutcome, number>>> {
  const counts: Partial<Record<SlackIntakeOutcome, number>> = {};
  for (let i = 0; i < limit; i += 1) {
    const outcome = await processNextSlackEvent(deps);
    if (!outcome) break;
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}
