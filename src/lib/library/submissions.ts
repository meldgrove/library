import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { CommandError } from "@/lib/commands";
import type { Database, Transaction } from "@/lib/db/client";
import { note, person, source, submission } from "@/lib/db/schema";
import { originalKey, type Storage } from "@/lib/storage";
import { NOTE_LIMITS, OPEN_SUBMISSION_STATUSES, type SubmissionChannel } from "./constants";
import { ACCEPTED_LABELS, ACCEPTED_TYPES, detectFileType } from "./file-types";
import { normalizeUrl, sha256Hex } from "./identify";
import { storeOriginal } from "./originals";

/*
 * Every way in (the upload page, the Slack bot, email, the import) ends here:
 * one source per file or link, one submission per upload. The worker does the
 * rest (`pipeline.ts`).
 */

export interface SubmitBase {
  submitterId: string;
  channel: SubmissionChannel;
  reason: string;
}

export interface SubmitFileInput extends SubmitBase {
  fileName: string;
  declaredMimeType?: string;
  bytes: Uint8Array;
}

export interface SubmitLinkInput extends SubmitBase {
  url: string;
}

const cleanReason = (reason: string) => reason.replace(/\s+/g, " ").trim().slice(0, NOTE_LIMITS.reason);

const cleanFileName = (name: string) =>
  name
    .replace(/[\u0000-\u001f\u007f/\\]+/g, " ")
    .trim()
    .slice(0, 200) || "upload";

async function insertSubmission(tx: Transaction, sourceId: string, input: SubmitBase): Promise<string> {
  const [created] = await tx
    .insert(submission)
    // Due by the worker's clock, not the database's: the two may differ by a moment.
    .values({ sourceId, submitterId: input.submitterId, channel: input.channel, reason: cleanReason(input.reason), nextAttemptAt: new Date() })
    .returning({ id: submission.id });
  await recordAudit(tx, {
    actorId: input.submitterId,
    action: "submission.received",
    subjectType: "submission",
    subjectId: created!.id,
    payload: { channel: input.channel, sourceId },
  });
  return created!.id;
}

/**
 * Stores the original (once per SHA-256) and records the upload. Refuses
 * files the library cannot read and files over the limit.
 */
export async function submitFile(
  db: Database | Transaction,
  storage: Storage,
  input: SubmitFileInput,
  maxBytes: number,
): Promise<{ submissionId: string; sourceId: string }> {
  if (input.bytes.byteLength === 0) throw new CommandError("invalid", "The file is empty.", { file: "The file is empty." });
  if (input.bytes.byteLength > maxBytes) {
    const message = `The file is larger than ${Math.round(maxBytes / 1_048_576)} MB.`;
    throw new CommandError("invalid", message, { file: message });
  }
  const type = detectFileType(input.bytes, input.fileName, input.declaredMimeType);
  if (!type) {
    const message = `The library takes ${ACCEPTED_LABELS} files.`;
    throw new CommandError("invalid", message, { file: message });
  }
  const sha256 = sha256Hex(input.bytes);
  const key = originalKey(sha256);
  return db.transaction(async (tx) => {
    // Stored before the row, under the original's lock: a row never points to a missing file.
    await storeOriginal(tx, storage, key, input.bytes, ACCEPTED_TYPES[type].mimeType);
    const [inserted] = await tx
      .insert(source)
      .values({
        kind: "file",
        sha256,
        fileName: cleanFileName(input.fileName),
        mimeType: ACCEPTED_TYPES[type].mimeType,
        sizeBytes: input.bytes.byteLength,
        storageKey: key,
      })
      // A source known without its original (e.g. imported) gets it now.
      .onConflictDoUpdate({
        target: source.sha256,
        targetWhere: sql`${source.sha256} is not null`,
        set: {
          storageKey: sql`coalesce(${source.storageKey}, excluded.storage_key)`,
          fileName: sql`coalesce(${source.fileName}, excluded.file_name)`,
          mimeType: sql`coalesce(${source.mimeType}, excluded.mime_type)`,
          sizeBytes: sql`coalesce(${source.sizeBytes}, excluded.size_bytes)`,
        },
      })
      .returning({ id: source.id });
    const sourceId = inserted!.id;
    return { submissionId: await insertSubmission(tx, sourceId, input), sourceId };
  });
}

/** Records a shared link; the worker downloads it. */
export async function submitLink(db: Database | Transaction, input: SubmitLinkInput): Promise<{ submissionId: string; sourceId: string }> {
  const normalizedUrl = normalizeUrl(input.url);
  if (!normalizedUrl) {
    throw new CommandError("invalid", "Enter a web link starting with https://.", { url: "Enter a web link starting with https://." });
  }
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(source)
      .values({ kind: "link", url: input.url.trim(), normalizedUrl })
      .onConflictDoNothing({ target: source.normalizedUrl, where: sql`${source.normalizedUrl} is not null` })
      .returning({ id: source.id });
    const sourceId = inserted?.id ?? (await tx.select({ id: source.id }).from(source).where(eq(source.normalizedUrl, normalizedUrl)))[0]!.id;
    return { submissionId: await insertSubmission(tx, sourceId, input), sourceId };
  });
}

/** A person's uploads, newest first, with the note each became or duplicates. */
export async function listMySubmissions(db: Database, personId: string, limit = 100) {
  return db
    .select({
      id: submission.id,
      channel: submission.channel,
      reason: submission.reason,
      status: submission.status,
      statusReason: submission.statusReason,
      createdAt: submission.createdAt,
      statusChangedAt: submission.statusChangedAt,
      fileName: source.fileName,
      url: source.url,
      detectedTitle: source.detectedTitle,
      noteNumber: note.number,
      noteTitle: note.title,
      noteStatus: note.status,
    })
    .from(submission)
    .innerJoin(source, eq(source.id, submission.sourceId))
    .leftJoin(note, eq(note.id, submission.noteId))
    .where(eq(submission.submitterId, personId))
    .orderBy(desc(submission.createdAt))
    .limit(limit);
}

/** How many uploads wait for the worker, for the admin page. */
export async function countOpenSubmissions(db: Database): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(submission)
    .where(inArray(submission.status, [...OPEN_SUBMISSION_STATUSES]));
  return row?.value ?? 0;
}

/** The submitter's name and team, for notes created from a submission. */
export async function submitterOf(tx: Database | Transaction, submissionId: string) {
  const [row] = await tx
    .select({ id: person.id, displayName: person.displayName, teamId: person.teamId, hasAccess: person.hasAccess })
    .from(submission)
    .innerJoin(person, eq(person.id, submission.submitterId))
    .where(and(eq(submission.id, submissionId)));
  return row;
}
