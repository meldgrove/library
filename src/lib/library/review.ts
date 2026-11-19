import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { canMaintain } from "@/lib/auth/roles";
import { CommandError, type Actor } from "@/lib/commands";
import type { Database, Transaction } from "@/lib/db/client";
import { documentType, note, noteTag, noteVersion, notificationDelivery, person, source, submission, tag, tagProposal, topicArea } from "@/lib/db/schema";
import { errorMessage, logger } from "@/lib/logger";
import { requestWebhookSync } from "@/lib/webhook/sync";
import type { Storage } from "@/lib/storage";
import { canEditNote, visibleNotes, visibleTagProposals, type Viewer } from "./access";
import { NOTE_LIMITS, notePath, noteRef } from "./constants";
import type { NoteFormInput } from "./note-input";
import { noteSearchText, snapshotOf } from "./note-text";
import { notifyPerson, notifyMaintainers } from "./notify";
import { cleanUpOriginals, requestOriginalCleanup } from "./originals";

/*
 * The uploader's review and the maintainers' work. Every command checks, writes,
 * and states its effects in one transaction: the audit event, the new
 * version, and, when the published state may change, a webhook sync.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** The uploader gets a reminder after a week; the maintainers hear of drafts open after 30 days. */
export const REMINDER_AFTER_DAYS = 7;
export const ESCALATE_AFTER_DAYS = 30;

const invalid = (field: string, message: string) => new CommandError("invalid", message, { [field]: message });

async function lockNote(tx: Transaction, noteId: string) {
  const [row] = await tx.select().from(note).where(eq(note.id, noteId)).for("update");
  if (!row) throw new CommandError("not_found", "This note does not exist.");
  return row;
}

function requireEditor(actor: Actor, row: typeof note.$inferSelect) {
  if (!canEditNote({ personId: actor.personId, role: actor.role, teamId: null }, row)) {
    throw new CommandError("forbidden", "Only the note's owner and the maintainers can change it.");
  }
}

function requireMaintainer(actor: Actor) {
  if (!canMaintain(actor.role)) throw new CommandError("forbidden", "Only maintainers can do this.");
}

/**
 * Saves the reviewer's changes. With `publish`, a draft becomes published:
 * confirmed by the reviewer, visible as chosen, and sent to the webhook unless
 * private. A published note can be edited the same way.
 */
export async function saveNote(db: Database, actor: Actor, noteId: string, input: NoteFormInput, now: Date = new Date()): Promise<{ number: number }> {
  return db.transaction(async (tx) => {
    const current = await lockNote(tx, noteId);
    requireEditor(actor, current);
    if (current.status === "discarded") throw new CommandError("invalid", "This draft was discarded.");
    const publishing = input.intent === "publish" && current.status === "draft";
    const published = publishing || current.status === "published";

    if (input.visibility === "team" && !current.teamId) throw invalid("visibility", "The owner has no team. Choose Everyone or Only me.");
    // The note's current entries stay valid when a maintainer deactivates them; new ones must be active.
    const [type] = input.documentTypeId ? await tx.select().from(documentType).where(eq(documentType.id, input.documentTypeId)) : [];
    if (input.documentTypeId && (!type || (!type.isActive && type.id !== current.documentTypeId))) {
      throw invalid("documentTypeId", "Choose a document type from the list.");
    }
    const [area] = input.topicAreaId ? await tx.select().from(topicArea).where(eq(topicArea.id, input.topicAreaId)) : [];
    if (input.topicAreaId && (!area || (!area.isActive && area.id !== current.topicAreaId))) {
      throw invalid("topicAreaId", "Choose a topic area from the list.");
    }
    const currentTagIds = new Set((await tx.select({ tagId: noteTag.tagId }).from(noteTag).where(eq(noteTag.noteId, noteId))).map((row) => row.tagId));
    // Tags already on the note stay valid when a maintainer deactivates them; new ones must be active.
    const tags = input.tagIds.length > 0 ? await tx.select().from(tag).where(inArray(tag.id, input.tagIds)) : [];
    if (tags.length !== new Set(input.tagIds).size || tags.some((t) => !t.isActive && !currentTagIds.has(t.id))) {
      throw invalid("tagIds", "Choose tags from the list.");
    }
    if (tags.length > NOTE_LIMITS.tags.max) throw invalid("tagIds", `Choose at most ${NOTE_LIMITS.tags.max} tags.`);

    if (published) {
      if (input.keyPoints.length < NOTE_LIMITS.keyPoints.min) {
        throw invalid("keyPoints", `Write at least ${NOTE_LIMITS.keyPoints.min} key points, one per line.`);
      }
      const [active] = await tx.select({ count: sql<number>`count(*)::int` }).from(tag).where(eq(tag.isActive, true));
      if ((active?.count ?? 0) >= NOTE_LIMITS.tags.min && tags.length < NOTE_LIMITS.tags.min) {
        throw invalid("tagIds", `Choose at least ${NOTE_LIMITS.tags.min} tags.`);
      }
    }

    const tagNames = tags.map((t) => t.name);
    const version = current.version + 1;
    const values = {
      title: input.title,
      core: input.core,
      keyPoints: input.keyPoints,
      quotes: input.quotes,
      citation: input.citation,
      language: input.language,
      documentTypeId: type?.id ?? null,
      topicAreaId: area?.id ?? null,
      visibility: input.visibility,
    };
    await tx
      .update(note)
      .set({
        ...values,
        version,
        searchText: noteSearchText({ keyPoints: input.keyPoints, quotes: input.quotes, citation: input.citation, tagNames }),
        updatedAt: now,
        ...(publishing
          ? { status: "published" as const, publishedAt: now, confirmedAt: now, confirmedById: actor.personId, uncertainFields: [] }
          : current.status === "published"
            ? // A maintainer's check was of the earlier version.
              { editedAt: now, checkedAt: null, checkedById: null }
            : {}),
      })
      .where(eq(note.id, noteId));
    await tx.delete(noteTag).where(eq(noteTag.noteId, noteId));
    if (tags.length > 0) await tx.insert(noteTag).values(tags.map((t) => ({ noteId, tagId: t.id })));
    const existingNames = new Set(
      (await tx.select({ name: tag.name }).from(tag)).map((row) => row.name.toLowerCase()),
    );
    for (const name of input.newTags) {
      if (existingNames.has(name.toLowerCase())) continue;
      await tx.insert(tagProposal).values({ name, noteId, proposedById: actor.personId });
    }
    await tx.insert(noteVersion).values({ noteId, version, snapshot: snapshotOf({ ...values, tagNames }), editorId: actor.personId });
    await recordAudit(tx, {
      actorId: actor.personId,
      action: publishing ? "note.published" : "note.edited",
      subjectType: "note",
      subjectId: noteId,
      payload: { number: current.number, version, visibility: input.visibility },
    });
    if (published || current.status === "published") await requestWebhookSync(tx, noteId, now);
    return { number: current.number };
  });
}

/** The uploader decides the source is not worth a note. Later uploads of it are blocked. */
export async function discardNote(db: Database, actor: Actor, noteId: string, now: Date = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockNote(tx, noteId);
    requireEditor(actor, current);
    if (current.status !== "draft") throw new CommandError("invalid", "Only drafts can be discarded. Delete a published note instead.");
    await tx.update(note).set({ status: "discarded", discardedAt: now, updatedAt: now }).where(eq(note.id, noteId));
    await tx.update(source).set({ blockedAt: now, blockedById: actor.personId, updatedAt: now }).where(eq(source.id, current.sourceId));
    await tx.update(tagProposal).set({ status: "rejected", resolvedAt: now }).where(and(eq(tagProposal.noteId, noteId), eq(tagProposal.status, "pending")));
    await recordAudit(tx, { actorId: actor.personId, action: "note.discarded", subjectType: "note", subjectId: noteId, payload: { number: current.number } });
  });
}

/** Deletes the originals right away when storage answers; the worker retries the rest. */
async function cleanUpNow(db: Database, storage: Storage | null, keys: string[]): Promise<void> {
  if (keys.length === 0 || !storage) return;
  try {
    await cleanUpOriginals(db, storage, { keys });
  } catch (error) {
    logger.warn({ error: errorMessage(error) }, "original cleanup failed; the worker tries again");
  }
}

/**
 * Deletes a note, its source, the uploads of it, and the stored originals:
 * for copyright or privacy requests. The webhook gets its removal at the next sync.
 * The audit log keeps only the note's number and the reason.
 */
export async function deleteNote(db: Database, storage: Storage | null, actor: Actor, noteId: string, reason: string, now: Date = new Date()): Promise<void> {
  const keys = await db.transaction(async (tx) => {
    const current = await lockNote(tx, noteId);
    requireEditor(actor, current);
    // The note's source, and the sources of uploads that were duplicates of it.
    const duplicateSources = await tx.select({ sourceId: submission.sourceId }).from(submission).where(eq(submission.noteId, noteId));
    const sourceIds = [...new Set([current.sourceId, ...duplicateSources.map((row) => row.sourceId)])];
    const sources = await tx.select({ id: source.id, storageKey: source.storageKey }).from(source).where(inArray(source.id, sourceIds));
    // Messages that name the note are not sent any more.
    await tx
      .update(notificationDelivery)
      .set({ status: "skipped", lastError: "The note was deleted." })
      .where(and(eq(notificationDelivery.noteId, noteId), eq(notificationDelivery.status, "pending")));
    await tx.delete(note).where(eq(note.id, noteId));
    // Uploads go with their sources (ON DELETE CASCADE); a source with its own note stays.
    const deletable = await tx
      .select({ id: source.id, storageKey: source.storageKey })
      .from(source)
      .where(and(inArray(source.id, sources.map((s) => s.id)), sql`not exists (select 1 from note where note.source_id = ${source.id})`));
    if (deletable.length > 0) await tx.delete(source).where(inArray(source.id, deletable.map((s) => s.id)));
    await recordAudit(tx, {
      actorId: actor.personId,
      action: "note.deleted",
      subjectType: "note",
      subjectId: noteId,
      payload: { number: current.number, reason: reason.slice(0, 300), sources: deletable.length },
    });
    await requestWebhookSync(tx, noteId, now);
    const keys = deletable.map((s) => s.storageKey);
    await requestOriginalCleanup(tx, keys, now);
    return keys.filter((key): key is string => key !== null);
  });
  await cleanUpNow(db, storage, keys);
}

/** A maintainer has checked a published note against its source. */
export async function checkNote(db: Database, actor: Actor, noteId: string, now: Date = new Date()): Promise<void> {
  requireMaintainer(actor);
  await db.transaction(async (tx) => {
    const current = await lockNote(tx, noteId);
    // A private note is its owner's alone, also for maintainers.
    requireEditor(actor, current);
    if (current.status !== "published") throw new CommandError("invalid", "Only published notes can be checked.");
    await tx.update(note).set({ checkedAt: now, checkedById: actor.personId, updatedAt: now }).where(eq(note.id, noteId));
    await recordAudit(tx, { actorId: actor.personId, action: "note.checked", subjectType: "note", subjectId: noteId, payload: { number: current.number } });
    await requestWebhookSync(tx, noteId, now);
  });
}

async function lockSubmission(tx: Transaction, submissionId: string) {
  const [row] = await tx.select().from(submission).where(eq(submission.id, submissionId)).for("update");
  if (!row) throw new CommandError("not_found", "This upload does not exist.");
  return row;
}

/** Lets a quarantined upload pass the screen: the maintainer checked it is fine. */
export async function releaseSubmission(db: Database, actor: Actor, submissionId: string, now: Date = new Date()): Promise<void> {
  requireMaintainer(actor);
  await db.transaction(async (tx) => {
    const row = await lockSubmission(tx, submissionId);
    if (row.status !== "quarantined") throw new CommandError("invalid", "Only uploads on hold after the screen can be released.");
    await tx
      .update(submission)
      .set({ status: "received", statusChangedAt: now, statusReason: null, releasedAt: now, releasedById: actor.personId, attempts: 0, nextAttemptAt: now, updatedAt: now })
      .where(eq(submission.id, submissionId));
    await recordAudit(tx, { actorId: actor.personId, action: "submission.released", subjectType: "submission", subjectId: submissionId });
  });
}

/** Tries a parked upload again, e.g. after OCR was set up or the AI model is back. */
export async function retrySubmission(db: Database, actor: Actor, submissionId: string, now: Date = new Date()): Promise<void> {
  requireMaintainer(actor);
  await db.transaction(async (tx) => {
    const row = await lockSubmission(tx, submissionId);
    if (row.status !== "parked") throw new CommandError("invalid", "Only parked uploads can be tried again.");
    await tx
      .update(submission)
      .set({ status: "received", statusChangedAt: now, statusReason: null, attempts: 0, nextAttemptAt: now, updatedAt: now })
      .where(eq(submission.id, submissionId));
    await recordAudit(tx, { actorId: actor.personId, action: "submission.retried", subjectType: "submission", subjectId: submissionId });
  });
}

/** Deletes an upload on hold; its source and original go too when nothing else uses them. */
export async function deleteSubmission(db: Database, storage: Storage | null, actor: Actor, submissionId: string): Promise<void> {
  requireMaintainer(actor);
  const keys = await db.transaction(async (tx) => {
    const row = await lockSubmission(tx, submissionId);
    if (row.status !== "quarantined" && row.status !== "parked") throw new CommandError("invalid", "Only uploads on hold can be deleted here.");
    await tx.delete(submission).where(eq(submission.id, submissionId));
    const orphan = await tx
      .delete(source)
      .where(
        and(
          eq(source.id, row.sourceId),
          sql`not exists (select 1 from note where note.source_id = ${source.id})`,
          sql`not exists (select 1 from submission where submission.source_id = ${source.id})`,
        ),
      )
      .returning({ storageKey: source.storageKey });
    await recordAudit(tx, { actorId: actor.personId, action: "submission.deleted", subjectType: "submission", subjectId: submissionId, payload: { sourceDeleted: orphan.length > 0 } });
    const keys = orphan.map((s) => s.storageKey);
    await requestOriginalCleanup(tx, keys);
    return keys.filter((key): key is string => key !== null);
  });
  await cleanUpNow(db, storage, keys);
}

/**
 * Reminds owners of drafts open for a week, and tells the maintainers about
 * drafts open for 30 days (not private ones). Each at most once per draft.
 */
export async function recordReviewReminders(db: Database, now: Date = new Date()): Promise<{ reminded: number; escalated: number }> {
  return db.transaction(async (tx) => {
    const needsReminder = and(isNull(note.reminderSentAt), lte(note.draftedAt, new Date(now.getTime() - REMINDER_AFTER_DAYS * DAY_MS)), eq(person.hasAccess, true));
    const needsEscalation = and(isNull(note.escalatedAt), ne(note.visibility, "private"), lte(note.draftedAt, new Date(now.getTime() - ESCALATE_AFTER_DAYS * DAY_MS)));
    // Acquire both sets of note locks in the same order as taxonomy decisions.
    const drafts = await tx
      .select({
        id: note.id,
        number: note.number,
        title: note.title,
        ownerId: note.ownerId,
        needsReminder: sql<boolean>`${needsReminder}`,
        needsEscalation: sql<boolean>`${needsEscalation}`,
      })
      .from(note)
      .innerJoin(person, eq(person.id, note.ownerId))
      .where(and(eq(note.status, "draft"), or(needsReminder, needsEscalation)))
      .orderBy(asc(note.id))
      .for("no key update", { of: note });
    const due = drafts.filter((row) => row.needsReminder);
    for (const row of due) {
      await notifyPerson(tx, {
        event: "review_reminder",
        subjectKey: row.id,
        recipientId: row.ownerId,
        channel: "slack",
        noteId: row.id,
        message: {
          subject: `Your draft waits: ${noteRef(row.number)} ${row.title}`,
          title: `${noteRef(row.number)} · ${row.title}`,
          text: "Your draft has waited a week. Check it and publish it, or discard it.",
          path: notePath(row.number),
        },
      });
      await tx.update(note).set({ reminderSentAt: now }).where(eq(note.id, row.id));
    }
    const overdue = drafts.filter((row) => row.needsEscalation);
    for (const row of overdue) {
      await notifyMaintainers(tx, {
        event: "review_escalated",
        subjectKey: row.id,
        channel: "email",
        noteId: row.id,
        message: {
          subject: `Maintenance: a draft has waited 30 days: ${noteRef(row.number)}`,
          title: `${noteRef(row.number)} · ${row.title}`,
          text: "This draft has waited 30 days for its owner. Review it, or ask the owner.",
          path: notePath(row.number),
        },
      });
      await tx.update(note).set({ escalatedAt: now }).where(eq(note.id, row.id));
    }
    return { reminded: due.length, escalated: overdue.length };
  });
}

/** The person's drafts, oldest first. */
export async function listMyDrafts(db: Database, personId: string) {
  return db
    .select({ id: note.id, number: note.number, title: note.title, draftedAt: note.draftedAt, uncertainFields: note.uncertainFields })
    .from(note)
    .where(and(eq(note.ownerId, personId), eq(note.status, "draft")))
    .orderBy(asc(note.draftedAt));
}

export async function countMyDrafts(db: Database, personId: string): Promise<number> {
  const [row] = await db.select({ value: sql<number>`count(*)::int` }).from(note).where(and(eq(note.ownerId, personId), eq(note.status, "draft")));
  return row?.value ?? 0;
}

/**
 * The maintainers' queues. Notes go through the access rule like everywhere, and
 * private drafts are their owners' alone: they are never escalated.
 */
export async function maintenanceQueues(db: Database, viewer: Viewer, now: Date = new Date()) {
  const showSource = or(isNull(note.id), visibleNotes(viewer));
  const [onHold, overdue, unchecked, [proposals]] = await Promise.all([
    db
      .select({
        id: submission.id,
        status: submission.status,
        statusReason: submission.statusReason,
        screenFindings: submission.screenFindings,
        createdAt: submission.createdAt,
        reason: submission.reason,
        submitterName: person.displayName,
        fileName: sql<string | null>`case when ${showSource} then ${source.fileName} end`,
        url: sql<string | null>`case when ${showSource} then ${source.url} end`,
        sourceId: source.id,
        hasOriginal: sql<boolean>`(${showSource} and ${source.storageKey} is not null)`,
      })
      .from(submission)
      .innerJoin(person, eq(person.id, submission.submitterId))
      .innerJoin(source, eq(source.id, submission.sourceId))
      .leftJoin(note, eq(note.sourceId, source.id))
      .where(inArray(submission.status, ["quarantined", "parked"]))
      .orderBy(asc(submission.statusChangedAt)),
    db
      .select({ id: note.id, number: note.number, title: note.title, draftedAt: note.draftedAt, ownerName: person.displayName })
      .from(note)
      .innerJoin(person, eq(person.id, note.ownerId))
      .where(
        and(visibleNotes(viewer), eq(note.status, "draft"), ne(note.visibility, "private"), lte(note.draftedAt, new Date(now.getTime() - ESCALATE_AFTER_DAYS * DAY_MS))),
      )
      .orderBy(asc(note.draftedAt)),
    db
      .select({ id: note.id, number: note.number, title: note.title, publishedAt: note.publishedAt, ownerName: person.displayName })
      .from(note)
      .innerJoin(person, eq(person.id, note.ownerId))
      .where(and(visibleNotes(viewer), eq(note.status, "published"), isNull(note.checkedAt), ne(note.visibility, "private")))
      .orderBy(desc(note.publishedAt))
      .limit(50),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(tagProposal)
      .leftJoin(note, eq(note.id, tagProposal.noteId))
      .where(and(eq(tagProposal.status, "pending"), visibleTagProposals(viewer))),
  ]);
  return { onHold, overdue, unchecked, pendingProposals: proposals?.value ?? 0 };
}

/** Uploads on hold and drafts overdue: the Maintenance badge. */
export async function countMaintenanceWork(db: Database, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({
      value: sql<number>`((select count(*) from submission where status in ('quarantined', 'parked')) + (select count(*) from note where status = 'draft' and visibility <> 'private' and drafted_at <= ${new Date(now.getTime() - ESCALATE_AFTER_DAYS * DAY_MS)}))::int`,
    })
    .from(sql`(select 1) as one`);
  return row?.value ?? 0;
}

