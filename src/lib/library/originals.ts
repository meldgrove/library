import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database, Transaction } from "@/lib/db/client";
import { source, storageCleanup } from "@/lib/db/schema";
import { errorMessage, logger } from "@/lib/logger";
import type { Storage } from "@/lib/storage";

/*
 * Stored originals are shared by content: one key per SHA-256. Storing a key
 * for a new source row and deleting a key nothing uses any more take the same
 * lock, so a cleanup cannot delete a file an upload has just started to use.
 * Deletions record their keys in `storage_cleanup` in their own transaction;
 * the cleanup retries until storage confirms.
 */

const BACKOFF_MS = [60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

async function lockOriginal(tx: Database | Transaction, key: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`original:${key}`}))`);
}

/**
 * Makes sure the original is stored, under the lock. Call it inside the
 * transaction that inserts or updates the row referencing `key`.
 */
export async function storeOriginal(tx: Transaction, storage: Storage, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  await lockOriginal(tx, key);
  if (!(await storage.exists(key))) await storage.put(key, bytes, contentType);
}

/** Records originals to delete, in the transaction that deletes their sources. */
export async function requestOriginalCleanup(tx: Transaction, keys: (string | null)[], now: Date = new Date()): Promise<void> {
  for (const key of new Set(keys)) {
    if (!key) continue;
    await tx
      .insert(storageCleanup)
      .values({ storageKey: key, requestedAt: now, nextAttemptAt: now })
      .onConflictDoUpdate({ target: storageCleanup.storageKey, set: { nextAttemptAt: now } });
  }
}

/**
 * Deletes recorded originals that no source uses, one lock each; a key a
 * source uses again is simply dropped from the list. Failures wait and are
 * tried again. Without `keys`, every due key is handled.
 */
export async function cleanUpOriginals(db: Database, storage: Storage, options: { keys?: string[]; now?: Date; limit?: number } = {}): Promise<number> {
  const now = options.now ?? new Date();
  const due = await db
    .select({ storageKey: storageCleanup.storageKey })
    .from(storageCleanup)
    .where(options.keys ? inArray(storageCleanup.storageKey, options.keys.length > 0 ? options.keys : [""]) : lte(storageCleanup.nextAttemptAt, now))
    .orderBy(asc(storageCleanup.nextAttemptAt))
    .limit(options.limit ?? 100);
  let deleted = 0;
  for (const { storageKey } of due) {
    await db.transaction(async (tx) => {
      await lockOriginal(tx, storageKey);
      const [row] = await tx.select().from(storageCleanup).where(eq(storageCleanup.storageKey, storageKey)).for("update", { skipLocked: true });
      if (!row) return;
      const [used] = await tx.select({ id: source.id }).from(source).where(eq(source.storageKey, storageKey)).limit(1);
      try {
        if (!used) {
          await storage.delete(storageKey);
          deleted += 1;
        }
        await tx.delete(storageCleanup).where(eq(storageCleanup.storageKey, storageKey));
      } catch (error) {
        const attempts = row.attempts + 1;
        await tx
          .update(storageCleanup)
          .set({ attempts, lastError: errorMessage(error).slice(0, 500), nextAttemptAt: new Date(now.getTime() + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!) })
          .where(and(eq(storageCleanup.storageKey, storageKey)));
        logger.warn({ storageKey, attempts, error: errorMessage(error) }, "original cleanup will be retried");
      }
    });
  }
  return deleted;
}

/** How many originals wait for deletion, for the admin page. */
export async function countPendingCleanups(db: Database): Promise<number> {
  const [row] = await db.select({ value: sql<number>`count(*)::int` }).from(storageCleanup);
  return row?.value ?? 0;
}
