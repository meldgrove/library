import { eq, desc, sql } from "drizzle-orm";
import { simpleParser } from "mailparser";
import { CommandError } from "@/lib/commands";
import type { Database, Transaction } from "@/lib/db/client";
import { emailMessage, person } from "@/lib/db/schema";
import { errorMessage, logger } from "@/lib/logger";
import type { NotificationMessage } from "@/lib/notifications/types";
import { consumeRateLimit, RateLimitError, WRITE_LIMIT } from "@/lib/rate-limit";
import type { Storage } from "@/lib/storage";
import { NOTE_LIMITS } from "./constants";
import { ACCEPTED_LABELS, looksAccepted } from "./file-types";
import { sha256Hex } from "./identify";
import { emailToAddress, notifyPerson } from "./notify";
import { submitFile, submitLink } from "./submissions";

/*
 * The email intake. Staff send or forward an email with links or attached
 * files to one mailbox; the subject says why. The worker reads unseen
 * messages over IMAP every 2 minutes and takes a message only when its sender
 * has access, writes from an allowed domain, and the receiving mail server
 * confirmed that domain (DKIM or SPF). Unauthenticated and automatic
 * messages get no answer. Each message is handled once (by Message-ID); the
 * reply is a notification row.
 */

const MAX_ITEMS = 10;
const MIN_REASON = 3;

// ---------------------------------------------------------------------------
// Pure checks
// ---------------------------------------------------------------------------

/** The domain of an address or a bare domain, lower-case; `@example.org` and `user@example.org` give `example.org`. */
const domainOf = (value: string) => value.trim().replace(/^"|"$/g, "").split("@").at(-1)!.toLowerCase().replace(/\.$/, "");

/** Folding undone and comments (in parentheses) removed. */
const unfold = (value: string) => {
  let text = value.replace(/\r?\n[ \t]+/g, " ");
  // Comments may be nested once, e.g. "(p=NONE sp=NONE (x))".
  for (let i = 0; i < 3; i += 1) text = text.replace(/\([^()]*\)/g, " ");
  return text;
};

export interface AuthenticationCheck {
  ok: boolean;
  /** What passed ("dkim", "spf") or why nothing did. */
  reason: string;
}

/**
 * Whether the receiving mail server confirmed the sender's domain: `dkim=pass`
 * with `header.d` (or `header.i`) of that domain, or `spf=pass` with
 * `smtp.mailfrom` of that domain. Only the topmost Authentication-Results
 * header counts: the receiving server adds it last, above any the sender
 * may have written.
 */
export function checkAuthentication(authenticationResults: readonly string[], fromDomain: string): AuthenticationCheck {
  const header = authenticationResults[0];
  if (!header) return { ok: false, reason: "no Authentication-Results header" };
  const domain = fromDomain.toLowerCase();
  const [, ...results] = unfold(header).split(";");
  for (const result of results) {
    const tokens = result.trim().split(/\s+/).filter(Boolean);
    const [method, outcome] = (tokens[0] ?? "").toLowerCase().split("=");
    if (outcome !== "pass") continue;
    const properties = new Map(
      tokens.slice(1).flatMap((token) => {
        const index = token.indexOf("=");
        return index > 0 ? [[token.slice(0, index).toLowerCase(), token.slice(index + 1)] as const] : [];
      }),
    );
    if (method === "dkim") {
      const signer = properties.get("header.d") ?? properties.get("header.i");
      if (signer && domainOf(signer) === domain) return { ok: true, reason: "dkim" };
    }
    if (method === "spf") {
      const mailFrom = properties.get("smtp.mailfrom") ?? properties.get("smtp.helo");
      if (mailFrom && domainOf(mailFrom) === domain) return { ok: true, reason: "spf" };
    }
  }
  return { ok: false, reason: `neither DKIM nor SPF passed for ${domain}` };
}

/** A raw header line as mailparser keeps it: the lower-case name and the whole line. */
export interface HeaderLine {
  key: string;
  line: string;
}

/** Auto-replies, bounces, and list mail: never answered, so two robots cannot write to each other forever. */
export function isAutomatic(headerLines: readonly HeaderLine[], fromAddress: string | null): boolean {
  const value = (name: string) => {
    const found = headerLines.find((header) => header.key === name);
    return found ? unfold(found.line.slice(found.line.indexOf(":") + 1)).trim().toLowerCase() : undefined;
  };
  const autoSubmitted = value("auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (/^(bulk|junk|list|auto_reply)$/.test(value("precedence") ?? "")) return true;
  if (["x-autoreply", "x-autorespond", "list-id", "list-unsubscribe"].some((name) => value(name) !== undefined)) return true;
  if (value("return-path") === "<>") return true;
  return fromAddress !== null && /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(fromAddress);
}

/** Where the sender's own text ends: the signature, or a forwarded or quoted message. */
const OWN_TEXT_END = [
  /^-- ?$/,
  /^-{2,}\s*(forwarded message|original message|weitergeleitete nachricht|ursprüngliche nachricht)/i,
  /^(begin forwarded message|anfang der weitergeleiteten nachricht):/i,
  /^_{10,}$/,
  /^(on|am) .{4,200}(wrote|schrieb):$/i,
];

/** The text the sender wrote: above the signature and any forwarded or quoted message. */
function ownText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const end = lines.findIndex((line) => OWN_TEXT_END.some((pattern) => pattern.test(line.trim())));
  return (end < 0 ? lines : lines.slice(0, end)).filter((line) => !/^\s*>/.test(line)).join("\n");
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`{}|\\^\[\]]+/gi;

const CLOSING: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * A link without the punctuation that ends the sentence around it. A closing
 * bracket stays when the link opened it, as in …/Heat_(thermodynamics).
 */
export function trimLink(link: string): string {
  let trimmed = link;
  for (;;) {
    const last = trimmed.at(-1);
    if (!last) return trimmed;
    if (/[.,;:!?'">]/.test(last)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    const opening = CLOSING[last];
    if (opening && trimmed.split(opening).length - 1 < trimmed.split(last).length - 1) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    return trimmed;
  }
}

/**
 * The web links in the sender's own text (not in the signature, nor in a
 * forwarded or quoted message, where newsletters bring dozens), without links
 * to the organisation's own domains.
 */
export function emailLinks(text: string, ownDomains: readonly string[]): string[] {
  const links: string[] = [];
  for (const match of ownText(text).matchAll(URL_PATTERN)) {
    const link = trimLink(match[0]);
    let host: string;
    try {
      host = new URL(link).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (ownDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) continue;
    if (!links.includes(link)) links.push(link);
  }
  return links;
}

/** Re:, Fwd:, WG:, AW: and the like at the start of a subject. */
const REPLY_PREFIX = /^\s*(?:re|fw|fwd|wg|aw|tr|sv|vs|antw)\s*(?:\[\d+\])?\s*:\s*/i;

/** Why the message is useful: the subject without reply prefixes, or the first line of the body that is not only a link. */
export function emailReason(subject: string | undefined, text: string): string {
  let reason = (subject ?? "").trim();
  while (REPLY_PREFIX.test(reason)) reason = reason.replace(REPLY_PREFIX, "");
  if (!reason.trim()) {
    reason =
      ownText(text)
        .split("\n")
        .map((line) =>
          line
            .replace(URL_PATTERN, " ")
            // What is left of "label [link]" once the link is gone.
            .replace(/\[\s*\]|\(\s*\)|<\s*>/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .find((line) => line.replace(/[\W_]+/g, "").length >= MIN_REASON) ?? "";
  }
  return reason.replace(/\s+/g, " ").trim().slice(0, NOTE_LIMITS.reason);
}

export interface IntakeEmail {
  messageId: string | null;
  from: string | null;
  subject: string | undefined;
  text: string;
  /** Raw values of the Authentication-Results headers, topmost first. */
  authenticationResults: string[];
  automatic: boolean;
  /** Attached files; inline images of signatures are left out. */
  attachments: { fileName: string; contentType: string; bytes: Uint8Array; inline: boolean }[];
}

/** Reads a message (RFC 822) with mailparser. */
export async function readEmail(source: Uint8Array): Promise<IntakeEmail> {
  const parsed = await simpleParser(Buffer.from(source), { skipImageLinks: true });
  const from = parsed.from?.value[0]?.address?.trim().toLowerCase() || null;
  return {
    messageId: parsed.messageId?.trim() || null,
    from,
    subject: parsed.subject,
    text: parsed.text ?? "",
    authenticationResults: parsed.headerLines.filter((line) => line.key === "authentication-results").map((line) => line.line.replace(/^[^:]*:\s*/, "")),
    automatic: isAutomatic(parsed.headerLines, from),
    attachments: parsed.attachments.map((attachment) => ({
      fileName: attachment.filename ?? "attachment",
      contentType: attachment.contentType,
      bytes: new Uint8Array(attachment.content),
      inline: attachment.contentDisposition !== "attachment" || Boolean(attachment.related),
    })),
  };
}

// ---------------------------------------------------------------------------
// The worker's step
// ---------------------------------------------------------------------------

/** A message in the intake mailbox. */
export interface MailboxMessage {
  uid: number;
  /** The whole message, or only its headers when it is larger than the limit. */
  source: Uint8Array;
  tooLarge: boolean;
}

/** The intake mailbox: IMAP in production (`src/lib/email/imap.ts`), a fake in tests. */
export interface IntakeMailbox {
  /** Unseen messages, oldest first, fetched one at a time as they are read. */
  unseen(limit: number): AsyncIterable<MailboxMessage>;
  /** Marks a message as seen and moves it to the done mailbox, if there is one. */
  done(uid: number): Promise<void>;
  close(): Promise<void>;
}

export interface EmailIntakeDeps {
  db: Database;
  storage: Storage;
  maxBytes: number;
  /** Allowed sender domains, lower-case. */
  domains: readonly string[];
}

export type EmailOutcome =
  | "added"
  | "refused"
  | "no_reason"
  | "nothing_to_add"
  | "rate_limited"
  | "too_large"
  | "no_access"
  | "duplicate"
  | "automatic"
  | "foreign_domain"
  | "unauthenticated"
  | "unreadable";

const NO_ACCESS: NotificationMessage = {
  subject: "The library could not take your email",
  title: "Library",
  text: "The library could not take your email: your address does not belong to anyone with access to the library. If you should have access, ask a library steward.",
  path: "/",
};

const replyMessage = (subject: string | undefined, text: string): NotificationMessage => ({
  subject: subject ? `Library: ${subject}`.slice(0, 200) : "Library: your email",
  title: "Your uploads",
  text,
  path: "/uploads",
});

async function personWithAccess(db: Database, address: string) {
  const [row] = await db
    .select({ id: person.id, hasAccess: person.hasAccess })
    .from(person)
    .where(sql`lower(${person.workEmail}) = ${address}`)
    .orderBy(desc(person.hasAccess))
    .limit(1);
  return row?.hasAccess ? row : undefined;
}

const record = (db: Database | Transaction, messageId: string, outcome: EmailOutcome, fromAddress: string | null, personId: string | null, now: Date) =>
  db.insert(emailMessage).values({ messageId, outcome, fromAddress, personId, processedAt: now }).onConflictDoNothing().returning({ messageId: emailMessage.messageId });

/** Handles one message. Throws only for errors worth trying again (e.g. the database). */
export async function handleEmail(deps: EmailIntakeDeps, message: MailboxMessage, now: Date = new Date()): Promise<EmailOutcome> {
  const { db } = deps;
  let email: IntakeEmail;
  try {
    email = await readEmail(message.source);
  } catch (error) {
    logger.warn({ uid: message.uid, error: errorMessage(error) }, "email could not be read");
    await record(db, `sha256:${sha256Hex(message.source)}`, "unreadable", null, null, now);
    return "unreadable";
  }
  const messageId = email.messageId ?? `sha256:${sha256Hex(message.source)}`;
  const [seen] = await db.select({ messageId: emailMessage.messageId }).from(emailMessage).where(eq(emailMessage.messageId, messageId));
  if (seen) return "duplicate";

  // Refused without an answer: robots, other domains, and senders the mail server did not confirm.
  const domain = email.from ? email.from.split("@")[1]! : null;
  const silent = async (outcome: EmailOutcome) => {
    await record(db, messageId, outcome, email.from, null, now);
    logger.info({ messageId, outcome }, "email refused");
    return outcome;
  };
  if (email.automatic) return silent("automatic");
  if (!email.from || !domain || !deps.domains.includes(domain)) return silent("foreign_domain");
  if (!checkAuthentication(email.authenticationResults, domain).ok) return silent("unauthenticated");

  const sender = await personWithAccess(db, email.from);
  if (!sender) {
    await db.transaction(async (tx) => {
      if ((await record(tx, messageId, "no_access", email.from, null, now)).length === 0) return;
      await emailToAddress(tx, { event: "intake_no_access", key: messageId, address: email.from!, message: NO_ACCESS });
    });
    return "no_access";
  }

  const answer = async (outcome: EmailOutcome, text: string) => {
    await db.transaction(async (tx) => {
      if ((await record(tx, messageId, outcome, email.from, sender.id, now)).length === 0) return;
      await notifyPerson(tx, { event: "intake_reply", subjectKey: `email:${messageId}`, recipientId: sender.id, channel: "email", message: replyMessage(email.subject, text) });
    });
    return outcome;
  };
  if (message.tooLarge) {
    return answer("too_large", `Your email is larger than the library takes. Send files of at most ${Math.round(deps.maxBytes / 1_048_576)} MB, or links.`);
  }

  const links = emailLinks(email.text, deps.domains);
  const files = email.attachments.filter((attachment) => looksAccepted(attachment.fileName, attachment.contentType));
  // Attached on purpose but of another type; inline images (signatures, logos) are not mentioned.
  const refusals = email.attachments
    .filter((attachment) => !attachment.inline && !files.includes(attachment))
    .map((attachment) => `${attachment.fileName}: The library takes ${ACCEPTED_LABELS} files.`);
  if (links.length === 0 && files.length === 0) {
    const text =
      refusals.length > 0
        ? ["Nothing was added:", ...refusals.map((line) => `- ${line}`)].join("\n")
        : "Send or forward an email with a link or an attached file, with one line on why it is useful as the subject.";
    return answer(refusals.length > 0 ? "refused" : "nothing_to_add", text);
  }
  const reason = emailReason(email.subject, email.text);
  if (reason.length < MIN_REASON) return answer("no_reason", "Write one line on why this is useful as the subject, then send the email again.");
  try {
    await consumeRateLimit(db, `write:${sender.id}`, WRITE_LIMIT, now);
  } catch (error) {
    if (error instanceof RateLimitError) return answer("rate_limited", error.message);
    throw error;
  }

  return db.transaction(async (tx) => {
    if ((await record(tx, messageId, "added", email.from, sender.id, now)).length === 0) return "duplicate";
    let added = 0;
    const base = { submitterId: sender.id, channel: "email" as const, reason };
    for (const [index, link] of links.entries()) {
      if (index >= MAX_ITEMS) {
        refusals.push(`${link}: The library takes at most ${MAX_ITEMS} links per email.`);
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
    for (const [index, file] of files.entries()) {
      if (index >= MAX_ITEMS) {
        refusals.push(`${file.fileName}: The library takes at most ${MAX_ITEMS} files per email.`);
        continue;
      }
      try {
        await submitFile(tx, deps.storage, { ...base, fileName: file.fileName, declaredMimeType: file.contentType, bytes: file.bytes }, deps.maxBytes);
        added += 1;
      } catch (error) {
        if (!(error instanceof CommandError)) throw error;
        refusals.push(`${file.fileName}: ${error.message}`);
      }
    }
    const outcome: EmailOutcome = added > 0 ? "added" : "refused";
    if (outcome !== "added") await tx.update(emailMessage).set({ outcome }).where(eq(emailMessage.messageId, messageId));
    const notAdded = refusals.map((line) => `- ${line}`);
    const text =
      added > 0
        ? [`Added to the library: ${added === 1 ? "1 upload" : `${added} uploads`}, with the reason "${reason}". The AI draft follows when it is ready.`, ...(notAdded.length > 0 ? ["", "Not added:", ...notAdded] : [])].join("\n")
        : ["Nothing was added:", ...notAdded].join("\n");
    await notifyPerson(tx, { event: "intake_reply", subjectKey: `email:${messageId}`, recipientId: sender.id, channel: "email", message: replyMessage(email.subject, text) });
    return outcome;
  });
}

/** Messages per run; the rest wait for the next one. */
const BATCH = 50;

/**
 * Reads the unseen messages of the intake mailbox and handles each. A handled
 * message is marked as seen (and moved); one that failed for a reason worth
 * trying again stays unseen for the next run.
 */
export async function pollMailbox(deps: EmailIntakeDeps, open: () => Promise<IntakeMailbox>, now: () => Date = () => new Date()): Promise<Partial<Record<EmailOutcome | "failed", number>>> {
  const counts: Partial<Record<EmailOutcome | "failed", number>> = {};
  const mailbox = await open();
  try {
    // One message in memory at a time: a batch of large messages would not fit.
    for await (const message of mailbox.unseen(BATCH)) {
      let outcome: EmailOutcome | "failed";
      try {
        outcome = await handleEmail(deps, message, now());
        await mailbox.done(message.uid);
      } catch (error) {
        outcome = "failed";
        logger.error({ uid: message.uid, error: errorMessage(error) }, "email will be tried again");
      }
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
  } finally {
    await mailbox.close();
  }
  return counts;
}
