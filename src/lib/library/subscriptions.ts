import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { CommandError } from "@/lib/commands";
import type { Database } from "@/lib/db/client";
import { tag, tagCluster, tagSubscription } from "@/lib/db/schema";

/*
 * The tags a person follows for their weekly email. A personal setting, like
 * the time zone: no audit event.
 */

/** At most this many tags per person. */
export const MAX_SUBSCRIPTIONS = 50;

/** The tags someone can follow, by cluster: the active ones, and the ones they follow already. */
export async function subscriptionOptions(db: Database, personId: string) {
  const followed = (await db.select({ tagId: tagSubscription.tagId }).from(tagSubscription).where(eq(tagSubscription.personId, personId))).map(
    (row) => row.tagId,
  );
  const tags = await db
    .select({ id: tag.id, name: tag.name, cluster: tagCluster.name })
    .from(tag)
    .leftJoin(tagCluster, eq(tagCluster.id, tag.clusterId))
    .where(or(eq(tag.isActive, true), followed.length > 0 ? inArray(tag.id, followed) : sql`false`))
    .orderBy(sql`${tagCluster.name} nulls last`, asc(sql`lower(${tag.name})`));
  const groups = new Map<string, { id: string; name: string }[]>();
  for (const t of tags) groups.set(t.cluster ?? "Other", [...(groups.get(t.cluster ?? "Other") ?? []), { id: t.id, name: t.name }]);
  return { followed, tagGroups: [...groups].map(([cluster, groupTags]) => ({ cluster, tags: groupTags })) };
}

/** Replaces the tags a person follows. New ones must be active. */
export async function saveTagSubscriptions(db: Database, personId: string, tagIds: string[], now: Date = new Date()): Promise<void> {
  const wanted = [...new Set(tagIds)];
  if (wanted.length > MAX_SUBSCRIPTIONS) {
    throw new CommandError("invalid", `Follow at most ${MAX_SUBSCRIPTIONS} tags.`, { tagIds: `Follow at most ${MAX_SUBSCRIPTIONS} tags.` });
  }
  await db.transaction(async (tx) => {
    const current = new Set(
      (await tx.select({ tagId: tagSubscription.tagId }).from(tagSubscription).where(eq(tagSubscription.personId, personId))).map((row) => row.tagId),
    );
    const found = wanted.length > 0 ? await tx.select({ id: tag.id, isActive: tag.isActive }).from(tag).where(inArray(tag.id, wanted)) : [];
    if (found.length !== wanted.length || found.some((t) => !t.isActive && !current.has(t.id))) {
      throw new CommandError("invalid", "Choose tags from the list.", { tagIds: "Choose tags from the list." });
    }
    const removed = [...current].filter((id) => !wanted.includes(id));
    if (removed.length > 0) await tx.delete(tagSubscription).where(and(eq(tagSubscription.personId, personId), inArray(tagSubscription.tagId, removed)));
    const added = wanted.filter((id) => !current.has(id));
    if (added.length > 0) await tx.insert(tagSubscription).values(added.map((tagId) => ({ personId, tagId, createdAt: now })));
  });
}
