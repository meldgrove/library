import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { CommandError, type Actor } from "@/lib/commands";
import type { Database, Transaction } from "@/lib/db/client";
import { documentType, note, noteTag, project, tag, tagCluster, tagProposal } from "@/lib/db/schema";

/*
 * The closed lists the AI model picks from: tags (grouped in clusters),
 * document types, and Projects. Stewards (admins) maintain them; the model
 * only proposes new tags.
 */

export const DEFAULT_DOCUMENT_TYPES = [
  "Study",
  "Report",
  "Article",
  "Policy paper",
  "Funder guideline",
  "Book",
  "Presentation",
  "Website",
  "Other",
] as const;

const NAME_MAX = 80;
export const nameSchema = z.string().trim().min(1, "Enter a name.").max(NAME_MAX, `At most ${NAME_MAX} characters.`);

function requireSteward(actor: Actor) {
  if (!actor.isAdmin) throw new CommandError("forbidden", "Only stewards can change the taxonomy.");
}

const lower = (column: typeof tag.name | typeof tagCluster.name | typeof documentType.name | typeof project.name) => sql`lower(${column})`;

/** The active lists, as the AI draft gets them. */
export async function draftLists(db: Database | Transaction) {
  const [tags, types, projects] = await Promise.all([
    db
      .select({ name: tag.name, description: tag.description, cluster: tagCluster.name })
      .from(tag)
      .leftJoin(tagCluster, eq(tagCluster.id, tag.clusterId))
      .where(eq(tag.isActive, true))
      .orderBy(asc(tagCluster.name), asc(tag.name)),
    db.select({ name: documentType.name }).from(documentType).where(eq(documentType.isActive, true)).orderBy(asc(documentType.name)),
    db.select({ name: project.name }).from(project).where(eq(project.isActive, true)).orderBy(asc(project.name)),
  ]);
  return {
    tags: tags.map((row) => ({ name: row.name, description: row.description, cluster: row.cluster ?? undefined })),
    documentTypes: types.map((row) => row.name),
    projects: projects.map((row) => row.name),
  };
}

/** Everything for the taxonomy page. */
export async function getTaxonomy(db: Database) {
  const [clusters, tags, types, projects, proposals] = await Promise.all([
    db.select().from(tagCluster).orderBy(lower(tagCluster.name)),
    db
      .select({
        id: tag.id,
        name: tag.name,
        description: tag.description,
        clusterId: tag.clusterId,
        isActive: tag.isActive,
        notes: sql<number>`(select count(*)::int from note_tag where note_tag.tag_id = ${tag.id})`,
      })
      .from(tag)
      .orderBy(lower(tag.name)),
    db.select().from(documentType).orderBy(lower(documentType.name)),
    db.select().from(project).orderBy(lower(project.name)),
    db
      .select({
        id: tagProposal.id,
        name: tagProposal.name,
        proposedById: tagProposal.proposedById,
        createdAt: tagProposal.createdAt,
        noteNumber: note.number,
        noteTitle: note.title,
      })
      .from(tagProposal)
      .leftJoin(note, eq(note.id, tagProposal.noteId))
      .where(eq(tagProposal.status, "pending"))
      .orderBy(asc(tagProposal.createdAt)),
  ]);
  return { clusters, tags, types, projects, proposals };
}

async function assertUnique(tx: Transaction, table: typeof tag | typeof tagCluster | typeof documentType | typeof project, name: string, exceptId?: string) {
  const [existing] = await tx
    .select({ id: table.id })
    .from(table)
    .where(sql`lower(${table.name}) = lower(${name})`)
    .limit(1);
  if (existing && existing.id !== exceptId) throw new CommandError("invalid", "This name exists already.", { name: "This name exists already." });
}

export async function createCluster(db: Database, actor: Actor, name: string): Promise<string> {
  requireSteward(actor);
  return db.transaction(async (tx) => {
    await assertUnique(tx, tagCluster, name);
    const [created] = await tx.insert(tagCluster).values({ name }).returning({ id: tagCluster.id });
    await recordAudit(tx, { actorId: actor.personId, action: "taxonomy.changed", subjectType: "tag", payload: { cluster: name, change: "cluster_created" } });
    return created!.id;
  });
}

export interface TagInput {
  name: string;
  description: string;
  clusterId: string | null;
}

export async function createTag(db: Database | Transaction, actor: Actor, input: TagInput): Promise<string> {
  requireSteward(actor);
  const run = async (tx: Transaction) => {
    await assertUnique(tx, tag, input.name);
    const [created] = await tx
      .insert(tag)
      .values({ name: input.name, description: input.description, clusterId: input.clusterId })
      .returning({ id: tag.id });
    await recordAudit(tx, { actorId: actor.personId, action: "tag.created", subjectType: "tag", subjectId: created!.id, payload: { name: input.name } });
    return created!.id;
  };
  // In a caller's transaction this becomes a savepoint.
  return db.transaction(run);
}

export async function updateTag(db: Database, actor: Actor, tagId: string, input: TagInput): Promise<void> {
  requireSteward(actor);
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(tag).where(eq(tag.id, tagId)).for("update");
    if (!current) throw new CommandError("not_found", "This tag does not exist.");
    await assertUnique(tx, tag, input.name, tagId);
    await tx.update(tag).set({ name: input.name, description: input.description, clusterId: input.clusterId, updatedAt: new Date() }).where(eq(tag.id, tagId));
    if (current.name !== input.name) {
      await recordAudit(tx, { actorId: actor.personId, action: "tag.renamed", subjectType: "tag", subjectId: tagId, payload: { from: current.name, to: input.name } });
    }
  });
}

export async function setTagActive(db: Database, actor: Actor, tagId: string, isActive: boolean): Promise<void> {
  requireSteward(actor);
  await db.transaction(async (tx) => {
    const updated = await tx.update(tag).set({ isActive, updatedAt: new Date() }).where(eq(tag.id, tagId)).returning({ id: tag.id });
    if (updated.length === 0) throw new CommandError("not_found", "This tag does not exist.");
    await recordAudit(tx, { actorId: actor.personId, action: isActive ? "tag.activated" : "tag.deactivated", subjectType: "tag", subjectId: tagId });
  });
}

type ListTable = typeof documentType | typeof project;

async function createListEntry(db: Database, actor: Actor, table: ListTable, subjectType: "document_type" | "project", name: string): Promise<string> {
  requireSteward(actor);
  return db.transaction(async (tx) => {
    await assertUnique(tx, table, name);
    const [created] = await tx.insert(table).values({ name }).returning({ id: table.id });
    await recordAudit(tx, { actorId: actor.personId, action: "taxonomy.changed", subjectType, subjectId: created!.id, payload: { name, change: "created" } });
    return created!.id;
  });
}

async function setListEntryActive(db: Database, actor: Actor, table: ListTable, subjectType: "document_type" | "project", id: string, isActive: boolean) {
  requireSteward(actor);
  await db.transaction(async (tx) => {
    const updated = await tx.update(table).set({ isActive, updatedAt: new Date() }).where(eq(table.id, id)).returning({ id: table.id });
    if (updated.length === 0) throw new CommandError("not_found", "This entry does not exist.");
    await recordAudit(tx, { actorId: actor.personId, action: "taxonomy.changed", subjectType, subjectId: id, payload: { change: isActive ? "activated" : "deactivated" } });
  });
}

export const createDocumentType = (db: Database, actor: Actor, name: string) => createListEntry(db, actor, documentType, "document_type", name);
export const setDocumentTypeActive = (db: Database, actor: Actor, id: string, isActive: boolean) =>
  setListEntryActive(db, actor, documentType, "document_type", id, isActive);
export const createProject = (db: Database, actor: Actor, name: string) => createListEntry(db, actor, project, "project", name);
export const setProjectActive = (db: Database, actor: Actor, id: string, isActive: boolean) => setListEntryActive(db, actor, project, "project", id, isActive);

/**
 * Accepts a tag proposal: as a new tag, or mapped to an existing one. The tag
 * is added to the note the proposal came from.
 */
export async function acceptTagProposal(
  db: Database,
  actor: Actor,
  proposalId: string,
  decision: { existingTagId: string } | { name: string; clusterId: string | null; description: string },
): Promise<void> {
  requireSteward(actor);
  await db.transaction(async (tx) => {
    const [proposal] = await tx.select().from(tagProposal).where(eq(tagProposal.id, proposalId)).for("update");
    if (!proposal) throw new CommandError("not_found", "This proposal does not exist.");
    if (proposal.status !== "pending") throw new CommandError("invalid", "This proposal was already decided.");
    let tagId: string;
    if ("existingTagId" in decision) {
      const [existing] = await tx.select({ id: tag.id }).from(tag).where(eq(tag.id, decision.existingTagId));
      if (!existing) throw new CommandError("not_found", "This tag does not exist.");
      tagId = existing.id;
    } else {
      tagId = await createTag(tx, actor, decision);
    }
    await tx
      .update(tagProposal)
      .set({ status: "accepted", tagId, resolvedById: actor.personId, resolvedAt: new Date() })
      .where(eq(tagProposal.id, proposalId));
    if (proposal.noteId) await tx.insert(noteTag).values({ noteId: proposal.noteId, tagId }).onConflictDoNothing();
    // The same name proposed for other notes is decided with it.
    const others = await tx
      .update(tagProposal)
      .set({ status: "accepted", tagId, resolvedById: actor.personId, resolvedAt: new Date() })
      .where(and(eq(tagProposal.status, "pending"), sql`lower(${tagProposal.name}) = lower(${proposal.name})`))
      .returning({ noteId: tagProposal.noteId });
    for (const other of others) if (other.noteId) await tx.insert(noteTag).values({ noteId: other.noteId, tagId }).onConflictDoNothing();
    await recordAudit(tx, { actorId: actor.personId, action: "tag_proposal.accepted", subjectType: "tag_proposal", subjectId: proposalId, payload: { tagId } });
  });
}

export async function rejectTagProposal(db: Database, actor: Actor, proposalId: string): Promise<void> {
  requireSteward(actor);
  await db.transaction(async (tx) => {
    const [proposal] = await tx.select().from(tagProposal).where(eq(tagProposal.id, proposalId)).for("update");
    if (!proposal) throw new CommandError("not_found", "This proposal does not exist.");
    if (proposal.status !== "pending") throw new CommandError("invalid", "This proposal was already decided.");
    await tx
      .update(tagProposal)
      .set({ status: "rejected", resolvedById: actor.personId, resolvedAt: new Date() })
      .where(and(eq(tagProposal.status, "pending"), sql`lower(${tagProposal.name}) = lower(${proposal.name})`));
    await recordAudit(tx, { actorId: actor.personId, action: "tag_proposal.rejected", subjectType: "tag_proposal", subjectId: proposalId });
  });
}

/** The file format of `npm run taxonomy:import`. */
export const taxonomyFileSchema = z.object({
  clusters: z
    .array(
      z.object({
        name: nameSchema,
        tags: z.array(z.union([nameSchema, z.object({ name: nameSchema, description: z.string().trim().max(300).default("") })])),
      }),
    )
    .default([]),
  documentTypes: z.array(nameSchema).default([]),
  projects: z.array(nameSchema).default([]),
});

export type TaxonomyFile = z.infer<typeof taxonomyFileSchema>;

/**
 * Adds what the file lists and is missing; changes and removes nothing. Run
 * again after editing the file: existing names are skipped.
 */
export async function importTaxonomy(db: Database, file: TaxonomyFile) {
  const counts = { clusters: 0, tags: 0, documentTypes: 0, projects: 0 };
  await db.transaction(async (tx) => {
    for (const cluster of file.clusters) {
      const [existing] = await tx.select({ id: tagCluster.id }).from(tagCluster).where(sql`lower(${tagCluster.name}) = lower(${cluster.name})`);
      let clusterId = existing?.id;
      if (!clusterId) {
        clusterId = (await tx.insert(tagCluster).values({ name: cluster.name }).returning({ id: tagCluster.id }))[0]!.id;
        counts.clusters += 1;
      }
      for (const entry of cluster.tags) {
        const { name, description } = typeof entry === "string" ? { name: entry, description: "" } : entry;
        const inserted = await tx
          .insert(tag)
          .values({ name, description, clusterId })
          .onConflictDoNothing()
          .returning({ id: tag.id });
        counts.tags += inserted.length;
      }
    }
    for (const name of file.documentTypes) {
      counts.documentTypes += (await tx.insert(documentType).values({ name }).onConflictDoNothing().returning({ id: documentType.id })).length;
    }
    for (const name of file.projects) {
      counts.projects += (await tx.insert(project).values({ name }).onConflictDoNothing().returning({ id: project.id })).length;
    }
    await recordAudit(tx, { actorId: null, action: "taxonomy.changed", subjectType: "tag", payload: { change: "imported", ...counts } });
  });
  return counts;
}

/** Adds the default document types when there are none yet, so the AI draft has a list from the start. */
export async function ensureDefaultDocumentTypes(db: Database): Promise<number> {
  const [any] = await db.select({ id: documentType.id }).from(documentType).limit(1);
  if (any) return 0;
  const inserted = await db
    .insert(documentType)
    .values(DEFAULT_DOCUMENT_TYPES.map((name) => ({ name })))
    .onConflictDoNothing()
    .returning({ id: documentType.id });
  return inserted.length;
}
