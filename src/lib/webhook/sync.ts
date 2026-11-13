import { and, asc, eq, isNotNull, lte, ne, sql } from "drizzle-orm";
import type { Database, Transaction } from "@/lib/db/client";
import { documentType, note, noteTag, person, project, source, tag, team, webhookSync } from "@/lib/db/schema";
import { errorMessage, logger } from "@/lib/logger";
import type { WebhookClient } from "./client";
import { noteChangedPayload, noteRemovedPayload, payloadHash, type NoteForWebhook } from "./payload";

/*
 * Keeps the webhook receiver in line with the library. Commands call
 * `requestWebhookSync` in their transaction whenever a note's published state
 * may have changed (publish, edit, visibility, discard, delete); the worker
 * then decides from the note as it is: a published note that is not private
 * is sent as `note.changed`, anything else as `note.removed` unless the
 * receiver accepted its removal before. A receiver answers 2xx to a removal
 * of a note it never had. A row is claimed with FOR UPDATE SKIP LOCKED, so
 * several workers never send the same note.
 */

const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

export async function requestWebhookSync(tx: Database | Transaction, noteId: string, now: Date = new Date()): Promise<void> {
  await tx
    .insert(webhookSync)
    .values({ noteId, action: "publish", requestedAt: now, nextAttemptAt: now })
    .onConflictDoUpdate({ target: webhookSync.noteId, set: { requestedAt: now, nextAttemptAt: now, attempts: 0 } });
}

/** Asks for every published note again; unchanged ones are not sent (payload hash). Nightly. */
export async function requestAllPublished(db: Database, now: Date = new Date()): Promise<number> {
  const rows = await db.select({ id: note.id }).from(note).where(and(eq(note.status, "published"), ne(note.visibility, "private")));
  for (const row of rows) await requestWebhookSync(db, row.id, now);
  return rows.length;
}

/** The note as the receiver should hold it, or null when it should not hold it. */
export async function noteForWebhook(db: Database | Transaction, noteId: string): Promise<NoteForWebhook | null> {
  const [row] = await db
    .select({
      note,
      ownerName: person.displayName,
      teamName: team.name,
      teamDirectoryId: team.externalId,
      documentType: documentType.name,
      project: project.name,
      sourceUrl: source.url,
      doi: source.doi,
    })
    .from(note)
    .innerJoin(person, eq(person.id, note.ownerId))
    .innerJoin(source, eq(source.id, note.sourceId))
    .leftJoin(team, eq(team.id, note.teamId))
    .leftJoin(documentType, eq(documentType.id, note.documentTypeId))
    .leftJoin(project, eq(project.id, note.projectId))
    .where(eq(note.id, noteId));
  if (!row || row.note.status !== "published" || row.note.visibility === "private" || !row.note.publishedAt) return null;
  const tags = await db.select({ name: tag.name }).from(noteTag).innerJoin(tag, eq(tag.id, noteTag.tagId)).where(eq(noteTag.noteId, noteId)).orderBy(asc(tag.name));
  return {
    id: row.note.id,
    number: row.note.number,
    title: row.note.title,
    core: row.note.core,
    keyPoints: row.note.keyPoints,
    quotes: row.note.quotes,
    citation: row.note.citation,
    language: row.note.language,
    visibility: row.note.visibility,
    publishedAt: row.note.publishedAt,
    editedAt: row.note.editedAt,
    team: row.teamName ? { name: row.teamName, directoryId: row.teamDirectoryId } : null,
    ownerName: row.ownerName,
    documentType: row.documentType,
    project: row.project,
    tags: tags.map((t) => t.name),
    sourceUrl: row.sourceUrl,
    doi: row.doi,
    checked: row.note.checkedAt !== null,
  };
}

export interface SyncDeps {
  db: Database;
  client: WebhookClient;
  baseUrl: string;
}

export type SyncOutcome = "published" | "removed" | "unchanged" | "retry";

/** Sends the next due note. Returns null when nothing is due. */
export async function syncNext(deps: SyncDeps, now: Date = new Date()): Promise<SyncOutcome | null> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(webhookSync)
      .where(and(isNotNull(webhookSync.requestedAt), lte(webhookSync.nextAttemptAt, now)))
      .orderBy(asc(webhookSync.nextAttemptAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;
    const done = (values: Partial<typeof webhookSync.$inferInsert>) =>
      tx
        .update(webhookSync)
        .set({ requestedAt: null, attempts: 0, lastError: null, nextAttemptAt: null, ...values })
        .where(eq(webhookSync.noteId, row.noteId));
    try {
      const current = await noteForWebhook(tx, row.noteId);
      if (!current) {
        // Only a removal the receiver accepted counts: a publish may have
        // been stored although its answer, or this row's update, was lost.
        if (row.action === "remove" && row.deliveredAt !== null && !row.everSent) {
          await done({});
          return "unchanged";
        }
        await deps.client.send(noteRemovedPayload(row.noteId));
        await done({ action: "remove", everSent: false, payloadHash: null, deliveredAt: now });
        return "removed";
      }
      const payload = noteChangedPayload(current, deps.baseUrl);
      const hash = payloadHash(payload);
      if (row.everSent && row.payloadHash === hash) {
        await done({ action: "publish" });
        return "unchanged";
      }
      await deps.client.send(payload);
      await done({ action: "publish", everSent: true, payloadHash: hash, deliveredAt: now });
      return "published";
    } catch (error) {
      const attempts = row.attempts + 1;
      const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!;
      await tx
        .update(webhookSync)
        .set({
          attempts,
          lastError: errorMessage(error).slice(0, 1_000),
          nextAttemptAt: new Date(now.getTime() + wait),
        })
        .where(eq(webhookSync.noteId, row.noteId));
      logger.warn({ noteId: row.noteId, attempts, error: errorMessage(error) }, "webhook delivery will be retried");
      return "retry";
    }
  });
}

export async function syncDue(deps: SyncDeps, limit = 50): Promise<Partial<Record<SyncOutcome, number>>> {
  const counts: Partial<Record<SyncOutcome, number>> = {};
  for (let i = 0; i < limit; i += 1) {
    const outcome = await syncNext(deps);
    if (!outcome) break;
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}

/** What the admin page shows. */
export async function getWebhookStatus(db: Database) {
  const [counts] = await db
    .select({
      delivered: sql<number>`count(*) filter (where ${webhookSync.everSent})::int`,
      waiting: sql<number>`count(*) filter (where ${webhookSync.requestedAt} is not null)::int`,
      failing: sql<number>`count(*) filter (where ${webhookSync.requestedAt} is not null and ${webhookSync.attempts} > 0)::int`,
      lastDeliveredAt: sql<Date | null>`max(${webhookSync.deliveredAt})`,
    })
    .from(webhookSync);
  const failing = await db
    .select({
      noteId: webhookSync.noteId,
      // Admins do not see private notes: those stay anonymous here.
      number: sql<number | null>`case when ${note.visibility} = 'private' then null else ${note.number} end`,
      title: sql<string | null>`case when ${note.visibility} = 'private' then null else ${note.title} end`,
      attempts: webhookSync.attempts,
      lastError: webhookSync.lastError,
      nextAttemptAt: webhookSync.nextAttemptAt,
    })
    .from(webhookSync)
    .leftJoin(note, eq(note.id, webhookSync.noteId))
    .where(and(isNotNull(webhookSync.requestedAt), sql`${webhookSync.attempts} > 0`))
    .orderBy(asc(webhookSync.nextAttemptAt))
    .limit(20);
  return {
    delivered: counts?.delivered ?? 0,
    waiting: counts?.waiting ?? 0,
    failingCount: counts?.failing ?? 0,
    lastDeliveredAt: counts?.lastDeliveredAt ? new Date(counts.lastDeliveredAt) : null,
    failing,
  };
}
