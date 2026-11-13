import path from "node:path";
import { and, asc, eq, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { recordAudit, type AuditAction } from "@/lib/audit";
import type { Database, Transaction } from "@/lib/db/client";
import { documentType, note, noteReason, noteTag, noteVersion, person, project, source, sourceText, submission, tag, tagProposal } from "@/lib/db/schema";
import { errorMessage, logger } from "@/lib/logger";
import { consumeRateLimit, RateLimitError } from "@/lib/rate-limit";
import { originalKey, type Storage } from "@/lib/storage";
import { noteRef, notePath, type ScreenFinding, type SubmissionStatus } from "./constants";
import { draftNote, DraftError, type DraftModel, type NoteDraft } from "./draft";
import { ACCEPTED_TYPES, detectFileType, extractText, ExtractionError, fromHtml, tidyText, type Extracted, type OcrOptions } from "./extract";
import { fetchLink, LinkError } from "./fetch-link";
import { findDoi, sha256Hex } from "./identify";
import { notifyPerson, notifyStewards } from "./notify";
import { storeOriginal } from "./originals";
import { describeFindings, screenText } from "./screen";
import { draftLists } from "./taxonomy";
import { noteSearchText, snapshotOf } from "./note-text";

/*
 * The worker's way for one upload, in a fixed order:
 *
 *   received → text extracted → screened → duplicate check → AI draft → note (draft)
 *
 * It stops early with a reason the uploader sees: quarantined (screen
 * finding; a steward releases or deletes), duplicate (the source has a note),
 * blocked (the source was discarded before), or parked (the text or the draft
 * failed; a steward retries or deletes). Only the draft uses the AI model.
 *
 * A submission is claimed with FOR UPDATE SKIP LOCKED, so several workers
 * never take the same one; the slow steps run outside any transaction.
 */

export interface PipelineDeps {
  db: Database;
  storage: Storage;
  model: DraftModel;
  ocr: OcrOptions;
  maxBytes: number;
  /** Drafts per day across all uploads. */
  dailyDraftLimit: number;
  /** Tests only: allow links to loopback addresses. */
  allowPrivateLinks?: boolean;
}

export type ProcessOutcome = Exclude<SubmissionStatus, "received" | "processing"> | "retry" | "waiting";

/** A submission stuck in "processing" this long (the worker stopped) is taken up again. */
const STALE_PROCESSING_MS = 30 * 60_000;
/** Waits after temporary errors (the AI model or a site cannot be reached). */
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

class Stop {
  constructor(
    readonly status: "quarantined" | "duplicate" | "blocked" | "parked",
    readonly reason: string,
    readonly extra: { noteId?: string; findings?: ScreenFinding[] } = {},
  ) {}
}

class Retry {
  constructor(readonly reason: string) {}
}

/** Claims the next due submission, or returns null. */
async function claimNext(db: Database, now: Date) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(submission)
      .where(
        or(
          and(eq(submission.status, "received"), lte(submission.nextAttemptAt, now)),
          and(eq(submission.status, "processing"), lte(submission.statusChangedAt, new Date(now.getTime() - STALE_PROCESSING_MS))),
        ),
      )
      .orderBy(asc(submission.nextAttemptAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;
    await tx
      .update(submission)
      .set({ status: "processing", statusChangedAt: now, attempts: row.attempts + 1, updatedAt: now })
      .where(eq(submission.id, row.id));
    return { ...row, attempts: row.attempts + 1 };
  });
}

type Claimed = NonNullable<Awaited<ReturnType<typeof claimNext>>>;
type SourceRow = typeof source.$inferSelect;

/** Downloads a link. A PDF behind a link is kept like an uploaded file. */
async function textOfLink(deps: PipelineDeps, row: SourceRow, claimed: Claimed): Promise<{ extracted: Extracted; sourceId: string }> {
  let fetched;
  try {
    fetched = await fetchLink(row.url!, { maxBytes: deps.maxBytes, allowPrivateAddresses: deps.allowPrivateLinks });
  } catch (error) {
    if (error instanceof LinkError) throw new Stop("parked", error.message);
    throw error;
  }
  const type = detectFileType(fetched.bytes, new URL(fetched.url).pathname, fetched.contentType);
  if (type === "html") return { extracted: fromHtml(new TextDecoder().decode(fetched.bytes)), sourceId: row.id };
  if (type === "text") {
    return { extracted: { text: tidyText(new TextDecoder().decode(fetched.bytes)), method: "text" }, sourceId: row.id };
  }
  if (type !== "pdf" && type !== "docx") throw new Stop("parked", "The link leads to a file type the library cannot read.");

  // A file behind a link: store it once, as for uploads.
  const sha256 = sha256Hex(fetched.bytes);
  const key = originalKey(sha256);
  const sourceId = await deps.db.transaction(async (tx) => {
    await storeOriginal(tx, deps.storage, key, fetched.bytes, ACCEPTED_TYPES[type].mimeType);
    const [sameFile] = await tx.select().from(source).where(and(eq(source.sha256, sha256), ne(source.id, row.id)));
    if (sameFile) {
      // Someone uploaded this file already: the upload belongs to that source.
      await tx.update(submission).set({ sourceId: sameFile.id }).where(eq(submission.id, claimed.id));
      // A source known without its original (e.g. imported) gets it now.
      if (!sameFile.storageKey) {
        await tx
          .update(source)
          .set({ storageKey: key, sizeBytes: fetched.bytes.byteLength, mimeType: ACCEPTED_TYPES[type].mimeType, updatedAt: new Date() })
          .where(eq(source.id, sameFile.id));
      }
      return sameFile.id;
    }
    // Name and type as for uploads, so a retry recognises the stored file.
    const extension = ACCEPTED_TYPES[type].extensions[0]!;
    const base = path.basename(new URL(fetched.url).pathname).slice(0, 150) || "link";
    await tx
      .update(source)
      .set({
        sha256,
        storageKey: key,
        sizeBytes: fetched.bytes.byteLength,
        mimeType: ACCEPTED_TYPES[type].mimeType,
        fileName: base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`,
        updatedAt: new Date(),
      })
      .where(eq(source.id, row.id));
    return row.id;
  });
  try {
    return { extracted: await extractText(fetched.bytes, type, deps.ocr), sourceId };
  } catch (error) {
    if (error instanceof ExtractionError) throw new Stop("parked", error.message);
    throw error;
  }
}

/** The source's text: stored from an earlier upload, or extracted now. */
async function ensureText(deps: PipelineDeps, claimed: Claimed): Promise<{ text: string; sourceId: string }> {
  const [row] = await deps.db.select().from(source).where(eq(source.id, claimed.sourceId));
  if (!row) throw new Stop("parked", "The source no longer exists.");
  const [stored] = await deps.db.select({ text: sourceText.text }).from(sourceText).where(eq(sourceText.sourceId, row.id));
  if (stored) return { text: stored.text, sourceId: row.id };

  let extracted: Extracted;
  let sourceId = row.id;
  if (row.kind === "link" && !row.storageKey) {
    ({ extracted, sourceId } = await textOfLink(deps, row, claimed));
    if (sourceId !== row.id) {
      const [existingText] = await deps.db.select({ text: sourceText.text }).from(sourceText).where(eq(sourceText.sourceId, sourceId));
      if (existingText) return { text: existingText.text, sourceId };
    }
  } else {
    const bytes = row.storageKey ? await deps.storage.get(row.storageKey) : null;
    if (!bytes) throw new Stop("parked", "The original file is missing from storage.");
    const type = detectFileType(bytes, row.fileName ?? "", row.mimeType ?? "");
    if (!type) throw new Stop("parked", "The library cannot read this file type.");
    try {
      extracted = await extractText(bytes, type, deps.ocr);
    } catch (error) {
      if (error instanceof ExtractionError) throw new Stop("parked", error.message);
      throw error;
    }
  }
  if (extracted.text.replace(/\s+/g, "").length < 50) throw new Stop("parked", "The source has almost no readable text.");
  await deps.db.transaction(async (tx) => {
    await tx.insert(sourceText).values({ sourceId, text: extracted.text }).onConflictDoNothing();
    const [current] = await tx.select({ url: source.url, normalizedUrl: source.normalizedUrl }).from(source).where(eq(source.id, sourceId));
    await tx
      .update(source)
      .set({
        extractionMethod: extracted.method,
        extractedAt: new Date(),
        textChars: extracted.text.length,
        detectedTitle: extracted.title?.slice(0, 300) ?? null,
        doi: findDoi(extracted.text) ?? (current?.url ? findDoi(current.url) : null),
        updatedAt: new Date(),
      })
      .where(eq(source.id, sourceId));
  });
  return { text: extracted.text, sourceId };
}

/** The note of this source, or of another source with the same DOI. */
async function existingNoteFor(db: Database | Transaction, sourceId: string) {
  const [own] = await db.select({ id: note.id, number: note.number, title: note.title, status: note.status }).from(note).where(eq(note.sourceId, sourceId));
  if (own) return own;
  const [row] = await db.select({ doi: source.doi }).from(source).where(eq(source.id, sourceId));
  if (!row?.doi) return undefined;
  const [byDoi] = await db
    .select({ id: note.id, number: note.number, title: note.title, status: note.status })
    .from(note)
    .innerJoin(source, eq(source.id, note.sourceId))
    .where(and(eq(source.doi, row.doi), ne(source.id, sourceId)))
    .limit(1);
  return byDoi;
}

async function checkDuplicate(db: Database | Transaction, sourceId: string): Promise<void> {
  const [row] = await db.select({ blockedAt: source.blockedAt }).from(source).where(eq(source.id, sourceId));
  if (row?.blockedAt) throw new Stop("blocked", "This source was discarded before, so the library does not draft it again.");
  const existing = await existingNoteFor(db, sourceId);
  if (!existing) return;
  if (existing.status === "discarded") throw new Stop("blocked", "This source was discarded before, so the library does not draft it again.");
  throw new Stop("duplicate", `The library has this source already: ${noteRef(existing.number)}.`, { noteId: existing.id });
}

async function createNote(deps: PipelineDeps, claimed: Claimed, sourceId: string, draft: NoteDraft, now: Date) {
  return deps.db.transaction(async (tx) => {
    // The same source, or one with the same DOI, may have been drafted from
    // another upload meanwhile: check again, serialized per DOI.
    const [identity] = await tx.select({ doi: source.doi }).from(source).where(eq(source.id, sourceId));
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${identity?.doi ? `doi:${identity.doi}` : `source:${sourceId}`}))`);
    await checkDuplicate(tx, sourceId);
    const [owner] = await tx.select({ teamId: person.teamId }).from(person).where(eq(person.id, claimed.submitterId));
    const [type] = draft.documentType
      ? await tx.select({ id: documentType.id }).from(documentType).where(eq(documentType.name, draft.documentType))
      : [];
    const [projectRow] = draft.project ? await tx.select({ id: project.id }).from(project).where(eq(project.name, draft.project)) : [];
    const tags = draft.tags.length > 0 ? await tx.select({ id: tag.id, name: tag.name }).from(tag).where(inArray(tag.name, draft.tags)) : [];
    // Without a team, "My team" would hide the note from everyone but its owner.
    const visibility = draft.visibility === "team" && !owner?.teamId ? "all" : draft.visibility;
    const values = {
      sourceId,
      ownerId: claimed.submitterId,
      teamId: owner?.teamId ?? null,
      visibility,
      status: "draft" as const,
      title: draft.title,
      core: draft.core,
      keyPoints: draft.keyPoints,
      quotes: draft.quotes,
      citation: draft.citation,
      language: draft.language,
      documentTypeId: type?.id ?? null,
      projectId: projectRow?.id ?? null,
      uncertainFields: draft.uncertainFields,
      draftModel: deps.model.name,
      draftedAt: now,
      searchText: noteSearchText({ keyPoints: draft.keyPoints, quotes: draft.quotes, citation: draft.citation, tagNames: tags.map((t) => t.name) }),
    };
    const [created] = await tx.insert(note).values(values).returning({ id: note.id, number: note.number });
    if (tags.length > 0) await tx.insert(noteTag).values(tags.map((t) => ({ noteId: created!.id, tagId: t.id })));
    for (const name of draft.proposedTags) await tx.insert(tagProposal).values({ name, noteId: created!.id });
    if (claimed.reason) await tx.insert(noteReason).values({ noteId: created!.id, personId: claimed.submitterId, reason: claimed.reason });
    await tx.insert(noteVersion).values({
      noteId: created!.id,
      version: 1,
      snapshot: snapshotOf({ ...values, tagNames: tags.map((t) => t.name) }),
      editorId: null,
    });
    await tx
      .update(submission)
      .set({ status: "drafted", statusChangedAt: now, statusReason: null, noteId: created!.id, updatedAt: now })
      .where(eq(submission.id, claimed.id));
    await recordAudit(tx, {
      actorId: null,
      action: "note.drafted",
      subjectType: "note",
      subjectId: created!.id,
      payload: { number: created!.number, submissionId: claimed.id, model: deps.model.name, uncertain: draft.uncertainFields },
    });
    await notifyPerson(tx, {
      event: "draft_ready",
      subjectKey: created!.id,
      recipientId: claimed.submitterId,
      channel: "slack",
      noteId: created!.id,
      message: {
        subject: `Review your draft: ${noteRef(created!.number)} ${draft.title}`,
        title: `${noteRef(created!.number)} · ${draft.title}`,
        text: "The AI draft of your upload is ready. Check it against the original, correct it, and publish it.",
        path: notePath(created!.number),
      },
    });
    return created!;
  });
}

const STOP_MESSAGES: Record<Stop["status"], { subject: string; text: (reason: string) => string; stewards: boolean }> = {
  quarantined: {
    subject: "Your upload is on hold",
    text: (reason) => `${reason} A steward checks it and releases or deletes it.`,
    stewards: true,
  },
  duplicate: { subject: "The library has your upload already", text: (reason) => `${reason} Your reason was added to the note.`, stewards: false },
  blocked: { subject: "Your upload was not drafted", text: (reason) => reason, stewards: false },
  parked: { subject: "Your upload could not be drafted", text: (reason) => `${reason} A steward will look at it.`, stewards: true },
};

async function stop(deps: PipelineDeps, claimed: Claimed, result: Stop, now: Date): Promise<ProcessOutcome> {
  await deps.db.transaction(async (tx) => {
    await tx
      .update(submission)
      .set({
        status: result.status,
        statusChangedAt: now,
        statusReason: result.reason,
        screenFindings: result.extra.findings ?? [],
        noteId: result.extra.noteId ?? null,
        updatedAt: now,
      })
      .where(eq(submission.id, claimed.id));
    if (result.status === "duplicate" && result.extra.noteId && claimed.reason) {
      const [already] = await tx
        .select({ id: noteReason.id })
        .from(noteReason)
        .where(and(eq(noteReason.noteId, result.extra.noteId), eq(noteReason.personId, claimed.submitterId)));
      if (!already) {
        await tx.insert(noteReason).values({ noteId: result.extra.noteId, personId: claimed.submitterId, reason: claimed.reason });
        await recordAudit(tx, { actorId: claimed.submitterId, action: "note.reason_added", subjectType: "note", subjectId: result.extra.noteId });
      }
    }
    await recordAudit(tx, {
      actorId: null,
      action: `submission.${result.status}` satisfies AuditAction,
      subjectType: "submission",
      subjectId: claimed.id,
      payload: { reason: result.reason, rules: result.extra.findings?.map((finding) => finding.rule) },
    });
    const copy = STOP_MESSAGES[result.status];
    const message = { subject: copy.subject, title: copy.subject, text: copy.text(result.reason), path: "/uploads" };
    await notifyPerson(tx, { event: result.status, subjectKey: claimed.id, recipientId: claimed.submitterId, channel: "slack", message });
    if (copy.stewards) {
      await notifyStewards(tx, {
        event: result.status,
        subjectKey: `${claimed.id}:steward`,
        channel: "email",
        message: { ...message, subject: `Steward: an upload is ${result.status}`, text: `${result.reason}`, path: "/steward" },
      });
    }
  });
  return result.status;
}

/** Processes the next due submission. Returns null when none is due. */
export async function processNext(deps: PipelineDeps, now: Date = new Date()): Promise<ProcessOutcome | null> {
  const claimed = await claimNext(deps.db, now);
  if (!claimed) return null;
  const log = logger.child({ submissionId: claimed.id, attempt: claimed.attempts });
  try {
    const { text, sourceId } = await ensureText(deps, claimed);
    if (!claimed.releasedAt) {
      const findings = screenText(text);
      if (findings.length > 0) throw new Stop("quarantined", describeFindings(findings), { findings });
    }
    await checkDuplicate(deps.db, sourceId);

    try {
      await consumeRateLimit(deps.db, "ai-draft", { limit: deps.dailyDraftLimit, windowSeconds: 86_400 }, now);
    } catch (error) {
      if (!(error instanceof RateLimitError)) throw error;
      // The budget is used up: wait for the next day, without counting an attempt.
      const tomorrow = new Date(Math.floor(now.getTime() / 86_400_000 + 1) * 86_400_000);
      await deps.db
        .update(submission)
        .set({ status: "received", statusChangedAt: now, statusReason: "Waiting for the next day's AI budget.", attempts: claimed.attempts - 1, nextAttemptAt: tomorrow })
        .where(eq(submission.id, claimed.id));
      log.info("AI draft budget used up for today");
      return "waiting";
    }

    const [row] = await deps.db.select().from(source).where(eq(source.id, sourceId));
    const lists = await draftLists(deps.db);
    let draft: NoteDraft;
    try {
      draft = await draftNote(deps.model, {
        text,
        detectedTitle: row?.detectedTitle ?? undefined,
        fileName: row?.fileName ?? undefined,
        url: row?.url ?? undefined,
        reason: claimed.reason,
        ...lists,
      });
    } catch (error) {
      if (error instanceof DraftError) throw new Stop("parked", `The AI draft failed: ${error.message}`);
      throw new Retry(`The AI model could not be reached: ${errorMessage(error)}`);
    }
    await createNote(deps, claimed, sourceId, draft, now);
    log.info("note drafted");
    return "drafted";
  } catch (error) {
    if (error instanceof Stop) {
      log.info({ status: error.status }, "submission stopped");
      return stop(deps, claimed, error, now);
    }
    const reason = error instanceof Retry ? error.reason : `Unexpected error: ${errorMessage(error)}`;
    if (claimed.attempts >= MAX_ATTEMPTS) {
      log.error({ error: reason }, "submission parked after repeated errors");
      return stop(deps, claimed, new Stop("parked", reason.slice(0, 500)), now);
    }
    const delay = RETRY_DELAYS_MS[claimed.attempts - 1] ?? RETRY_DELAYS_MS.at(-1)!;
    await deps.db
      .update(submission)
      .set({ status: "received", statusChangedAt: now, statusReason: reason.slice(0, 500), nextAttemptAt: new Date(now.getTime() + delay) })
      .where(eq(submission.id, claimed.id));
    log.warn({ error: reason }, "submission will be retried");
    return "retry";
  }
}

/** Processes due submissions until none is left or `limit` is reached. */
export async function processDue(deps: PipelineDeps, limit = 20): Promise<Partial<Record<ProcessOutcome, number>>> {
  const counts: Partial<Record<ProcessOutcome, number>> = {};
  for (let i = 0; i < limit; i += 1) {
    const outcome = await processNext(deps);
    if (!outcome) break;
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    if (outcome === "waiting") break;
  }
  return counts;
}

/** Polls for due submissions every `intervalMs`. Returns a function that stops and waits for the current run. */
export function startProcessor(deps: PipelineDeps, intervalMs: number): () => Promise<void> {
  let running: Promise<unknown> | undefined;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = processDue(deps)
      .catch((error: unknown) => logger.error({ error: errorMessage(error) }, "processing failed"))
      .finally(() => {
        running = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

/** Uploads that are not finished, for the steward page and the admin page. */
export async function openProblemCount(db: Database): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(submission)
    .where(and(inArray(submission.status, ["quarantined", "parked"]), isNotNull(submission.id)));
  return row?.value ?? 0;
}
