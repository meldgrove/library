import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { canMaintain } from "@/lib/auth/roles";
import { CommandError, type Actor } from "@/lib/commands";
import type { Database, Transaction } from "@/lib/db/client";
import { documentType, note, noteTag, tag, tagCluster, tagProposal, topicArea } from "@/lib/db/schema";
import { visibleNotes, visibleTagProposals, type Viewer } from "./access";
import type { ListEntry } from "./constants";

/*
 * The closed lists the AI model picks from: tags (grouped in clusters),
 * document types, and topic areas. Maintainers keep them; the model
 * only proposes new tags.
 */

/** Added when the library has no document types yet; maintainers change them from then on. */
export const DEFAULT_DOCUMENT_TYPES = [
  { name: "Study", description: "Research with its own data or analysis, such as a survey, an evaluation, or an academic paper" },
  { name: "Report", description: "An organization's account of its work or findings, such as an annual or a situation report" },
  { name: "Article", description: "A news, magazine, or blog article" },
  { name: "Policy paper", description: "A position paper, strategy, or proposal on policy" },
  { name: "Funder guideline", description: "A funder's call, program guidelines, or application rules" },
  { name: "Book", description: "A book or a chapter of one" },
  { name: "Presentation", description: "Slides or the handout of a talk" },
  { name: "Website", description: "A web page that is not an article, such as an organization's or a program's page" },
  { name: "Podcast", description: "A podcast episode, or its page with show notes" },
  { name: "Transcript", description: "The written record of something spoken, such as a talk, an interview, a hearing, or a podcast episode" },
  { name: "Social media post", description: "A post or thread on a social network" },
  { name: "Other", description: "A source that fits none of the other types" },
] as const;

/** Added when the library has no topic areas yet; maintainers change them from then on. */
export const DEFAULT_TOPIC_AREAS = [
  { name: "Aging", description: "Older people, retirement, and an aging society" },
  { name: "Agriculture & land use", description: "Farming, livestock, forestry, agroforestry, paludiculture on rewetted peatlands, and rural areas" },
  { name: "Arts & culture", description: "Art, culture, cultural institutions, and heritage" },
  { name: "Building & housing", description: "Construction, housing, rents, and urban and rural development" },
  { name: "Circular economy", description: "Recycling, reuse, repair, waste prevention, and resource efficiency" },
  { name: "Civil society & philanthropy", description: "Nonprofits, foundations, volunteering, fundraising, and running a nonprofit" },
  { name: "Climate action & nature", description: "Climate protection and adaptation, biodiversity, and nature conservation" },
  { name: "Community & social cohesion", description: "Neighborhoods, social cohesion, and living together" },
  { name: "Cross-cutting", description: "A source that spans several topic areas equally" },
  { name: "Economy & industry", description: "Businesses, industry, trade, and economic policy" },
  { name: "Education", description: "Early childhood, school, university, and adult education" },
  { name: "Energy & utilities", description: "Energy supply and the energy transition, water, and other public utilities" },
  { name: "Equality & human rights", description: "Gender equality, anti-discrimination, and human rights" },
  { name: "Europe", description: "The European Union, its policies and funding, and European cooperation" },
  { name: "Family & children", description: "Families, parenting, childcare, and children's rights" },
  { name: "Finance", description: "Public budgets, taxes, and the financial system" },
  { name: "Food & nutrition", description: "Diets, food systems, food security, and meals in daycare centers, schools, hospitals, and canteens" },
  { name: "Health", description: "Health care, prevention, public health, and medicine" },
  { name: "International cooperation & development", description: "Global development, humanitarian aid, foreign policy, and peace" },
  { name: "Justice & law", description: "Courts, legislation, legal rights, and the justice system" },
  { name: "Media & communication", description: "Journalism, public communication, social media, and disinformation" },
  { name: "Migration & refugees", description: "Migration, asylum, refugees, and integration" },
  { name: "Mobility & logistics", description: "Transportation, public transit, traffic, and freight" },
  { name: "Nursing & care", description: "Long-term care, nursing, care work, and family caregivers" },
  { name: "Other", description: "A source that fits none of the other topic areas" },
  { name: "Politics & democracy", description: "Government, parties, elections, participation, and defending democracy" },
  { name: "Public administration & civil service", description: "Public authorities, the civil service, and administrative reform" },
  { name: "Public safety", description: "Police, crime prevention, extremism, and civil protection" },
  { name: "Religion & belief", description: "Religions, religious communities, and worldviews" },
  { name: "Research", description: "Science, research institutions, research funding, and methods" },
  { name: "Social affairs & inclusion", description: "Poverty, social security, disability, and equal participation" },
  { name: "Sports", description: "Sports, physical activity, and sports clubs" },
  { name: "Technology & digital transformation", description: "Digital technology, AI, data, and the digital transformation" },
  { name: "Tourism", description: "Travel, tourism, and hospitality" },
  { name: "Work & skilled labor", description: "Employment, working conditions, vocational training, and the shortage of skilled workers" },
  { name: "Youth", description: "Young people, youth work, and youth participation" },
] as const;

const NAME_MAX = 80;
const DESCRIPTION_MAX = 300;
export const nameSchema = z.string().trim().min(1, "Enter a name.").max(NAME_MAX, `At most ${NAME_MAX} characters.`);
/** One line on what an entry covers, for the AI model. */
export const descriptionSchema = z.string().trim().max(DESCRIPTION_MAX, `At most ${DESCRIPTION_MAX} characters.`).default("");

function requireMaintainer(actor: Actor) {
  if (!canMaintain(actor.role)) throw new CommandError("forbidden", "Only maintainers can change the taxonomy.");
}

const lower = (column: typeof tag.name | typeof tagCluster.name | typeof documentType.name | typeof topicArea.name) => sql`lower(${column})`;
const matchesIds = (column: typeof tagProposal.id | typeof tagProposal.noteId, ids: string[]) =>
  sql`${column} = any(${sql.param(ids)}::uuid[])`;

/** The active lists, as the AI draft gets them. */
export async function draftLists(db: Database | Transaction) {
  const [tags, types, areas] = await Promise.all([
    db
      .select({ name: tag.name, description: tag.description, cluster: tagCluster.name })
      .from(tag)
      .leftJoin(tagCluster, eq(tagCluster.id, tag.clusterId))
      .where(eq(tag.isActive, true))
      .orderBy(asc(tagCluster.name), asc(tag.name)),
    db
      .select({ name: documentType.name, description: documentType.description })
      .from(documentType)
      .where(eq(documentType.isActive, true))
      .orderBy(asc(documentType.name)),
    db.select({ name: topicArea.name, description: topicArea.description }).from(topicArea).where(eq(topicArea.isActive, true)).orderBy(asc(topicArea.name)),
  ]);
  return {
    tags: tags.map((row) => ({ name: row.name, description: row.description, cluster: row.cluster ?? undefined })),
    documentTypes: types,
    topicAreas: areas,
  };
}

/** Everything for the taxonomy page. */
export async function getTaxonomy(db: Database, viewer: Viewer) {
  const [clusters, tags, types, topicAreas, proposals] = await Promise.all([
    db
      .select({ id: tagCluster.id, name: tagCluster.name, tags: sql<number>`count(${tag.id})::int` })
      .from(tagCluster)
      .leftJoin(tag, eq(tag.clusterId, tagCluster.id))
      .groupBy(tagCluster.id)
      .orderBy(lower(tagCluster.name)),
    db
      .select({
        id: tag.id,
        name: tag.name,
        description: tag.description,
        clusterId: tag.clusterId,
        isActive: tag.isActive,
        notes: sql<number>`count(${note.id})::int`,
      })
      .from(tag)
      .leftJoin(noteTag, eq(noteTag.tagId, tag.id))
      .leftJoin(note, and(eq(note.id, noteTag.noteId), visibleNotes(viewer)))
      .groupBy(tag.id)
      .orderBy(lower(tag.name)),
    // Like the tags: only notes the viewer may see are counted.
    db
      .select({
        id: documentType.id,
        name: documentType.name,
        description: documentType.description,
        isActive: documentType.isActive,
        notes: sql<number>`count(${note.id})::int`,
      })
      .from(documentType)
      .leftJoin(note, and(eq(note.documentTypeId, documentType.id), visibleNotes(viewer)))
      .groupBy(documentType.id)
      .orderBy(lower(documentType.name)),
    db
      .select({
        id: topicArea.id,
        name: topicArea.name,
        description: topicArea.description,
        isActive: topicArea.isActive,
        notes: sql<number>`count(${note.id})::int`,
      })
      .from(topicArea)
      .leftJoin(note, and(eq(note.topicAreaId, topicArea.id), visibleNotes(viewer)))
      .groupBy(topicArea.id)
      .orderBy(lower(topicArea.name)),
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
      .where(and(eq(tagProposal.status, "pending"), visibleTagProposals(viewer)))
      .orderBy(asc(tagProposal.createdAt)),
  ]);
  return { clusters, tags, types, topicAreas, proposals };
}

async function assertUnique(tx: Transaction, table: typeof tag | typeof tagCluster | typeof documentType | typeof topicArea, name: string, exceptId?: string) {
  const [existing] = await tx
    .select({ id: table.id })
    .from(table)
    .where(sql`lower(${table.name}) = lower(${name})`)
    .limit(1);
  if (existing && existing.id !== exceptId) throw new CommandError("invalid", "This name exists already.", { name: "This name exists already." });
}

export async function createCluster(db: Database, actor: Actor, name: string): Promise<string> {
  requireMaintainer(actor);
  return db.transaction(async (tx) => {
    await assertUnique(tx, tagCluster, name);
    const [created] = await tx.insert(tagCluster).values({ name }).returning({ id: tagCluster.id });
    await recordAudit(tx, { actorId: actor.personId, action: "taxonomy.changed", subjectType: "tag_cluster", subjectId: created!.id, payload: { name, change: "created" } });
    return created!.id;
  });
}

export async function renameCluster(db: Database, actor: Actor, clusterId: string, name: string): Promise<void> {
  requireMaintainer(actor);
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(tagCluster).where(eq(tagCluster.id, clusterId)).for("update");
    if (!current) throw new CommandError("not_found", "This cluster does not exist.");
    await assertUnique(tx, tagCluster, name, clusterId);
    if (current.name === name) return;
    await tx.update(tagCluster).set({ name, updatedAt: new Date() }).where(eq(tagCluster.id, clusterId));
    await recordAudit(tx, { actorId: actor.personId, action: "taxonomy.changed", subjectType: "tag_cluster", subjectId: clusterId, payload: { change: "renamed", from: current.name, to: name } });
  });
}

/** Deletes a cluster. Its tags stay, without a cluster; notes carry tags, never clusters. */
export async function deleteCluster(db: Database, actor: Actor, clusterId: string): Promise<void> {
  requireMaintainer(actor);
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(tagCluster).where(eq(tagCluster.id, clusterId)).for("update");
    if (!current) throw new CommandError("not_found", "This cluster does not exist.");
    const released = await tx.update(tag).set({ clusterId: null, updatedAt: new Date() }).where(eq(tag.clusterId, clusterId)).returning({ id: tag.id });
    await tx.delete(tagCluster).where(eq(tagCluster.id, clusterId));
    await recordAudit(tx, {
      actorId: actor.personId,
      action: "taxonomy.changed",
      subjectType: "tag_cluster",
      subjectId: clusterId,
      payload: { change: "deleted", name: current.name, tags: released.length },
    });
  });
}

export interface TagInput {
  name: string;
  description: string;
  clusterId: string | null;
}

export async function createTag(db: Database | Transaction, actor: Actor, input: TagInput): Promise<string> {
  requireMaintainer(actor);
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
  requireMaintainer(actor);
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
  requireMaintainer(actor);
  await db.transaction(async (tx) => {
    const updated = await tx.update(tag).set({ isActive, updatedAt: new Date() }).where(eq(tag.id, tagId)).returning({ id: tag.id });
    if (updated.length === 0) throw new CommandError("not_found", "This tag does not exist.");
    await recordAudit(tx, { actorId: actor.personId, action: isActive ? "tag.activated" : "tag.deactivated", subjectType: "tag", subjectId: tagId });
  });
}

type ListTable = typeof documentType | typeof topicArea;
type ListSubject = "document_type" | "topic_area";

async function createListEntry(db: Database, actor: Actor, table: ListTable, subjectType: ListSubject, input: ListEntry): Promise<string> {
  requireMaintainer(actor);
  return db.transaction(async (tx) => {
    await assertUnique(tx, table, input.name);
    const [created] = await tx.insert(table).values({ name: input.name, description: input.description }).returning({ id: table.id });
    await recordAudit(tx, { actorId: actor.personId, action: "taxonomy.changed", subjectType, subjectId: created!.id, payload: { name: input.name, change: "created" } });
    return created!.id;
  });
}

/** Renames an entry or changes its description; notes keep it under the new name. */
async function updateListEntry(db: Database, actor: Actor, table: ListTable, subjectType: ListSubject, id: string, input: ListEntry) {
  requireMaintainer(actor);
  await db.transaction(async (tx) => {
    const [current] = await tx.select({ name: table.name }).from(table).where(eq(table.id, id)).for("update");
    if (!current) throw new CommandError("not_found", "This entry does not exist.");
    await assertUnique(tx, table, input.name, id);
    await tx.update(table).set({ name: input.name, description: input.description, updatedAt: new Date() }).where(eq(table.id, id));
    if (current.name !== input.name) {
      await recordAudit(tx, { actorId: actor.personId, action: "taxonomy.changed", subjectType, subjectId: id, payload: { change: "renamed", from: current.name, to: input.name } });
    }
  });
}

async function setListEntryActive(db: Database, actor: Actor, table: ListTable, subjectType: ListSubject, id: string, isActive: boolean) {
  requireMaintainer(actor);
  await db.transaction(async (tx) => {
    const updated = await tx.update(table).set({ isActive, updatedAt: new Date() }).where(eq(table.id, id)).returning({ id: table.id });
    if (updated.length === 0) throw new CommandError("not_found", "This entry does not exist.");
    await recordAudit(tx, { actorId: actor.personId, action: "taxonomy.changed", subjectType, subjectId: id, payload: { change: isActive ? "activated" : "deactivated" } });
  });
}

export const createDocumentType = (db: Database, actor: Actor, input: ListEntry) => createListEntry(db, actor, documentType, "document_type", input);
export const updateDocumentType = (db: Database, actor: Actor, id: string, input: ListEntry) => updateListEntry(db, actor, documentType, "document_type", id, input);
export const setDocumentTypeActive = (db: Database, actor: Actor, id: string, isActive: boolean) =>
  setListEntryActive(db, actor, documentType, "document_type", id, isActive);
export const createTopicArea = (db: Database, actor: Actor, input: ListEntry) => createListEntry(db, actor, topicArea, "topic_area", input);
export const updateTopicArea = (db: Database, actor: Actor, id: string, input: ListEntry) => updateListEntry(db, actor, topicArea, "topic_area", id, input);
export const setTopicAreaActive = (db: Database, actor: Actor, id: string, isActive: boolean) => setListEntryActive(db, actor, topicArea, "topic_area", id, isActive);

/** Lock notes before proposals, in the same order as note edits and deletions. */
async function lockProposals(tx: Transaction, actor: Actor, proposalId: string) {
  const viewer = { ...actor, teamId: null };
  const [target] = await tx.select({ name: tagProposal.name })
    .from(tagProposal)
    .leftJoin(note, eq(note.id, tagProposal.noteId))
    .where(and(eq(tagProposal.id, proposalId), visibleTagProposals(viewer)));
  if (!target) throw new CommandError("not_found", "This proposal does not exist.");

  const sameName = sql`lower(${tagProposal.name}) = lower(${target.name})`;
  const candidates = and(sameName, or(eq(tagProposal.id, proposalId), eq(tagProposal.status, "pending")));
  // Hold visibility stable for every note that may receive a tag.
  const lockedNotes = await tx.select({ id: note.id })
    .from(tagProposal)
    .innerJoin(note, eq(note.id, tagProposal.noteId))
    .where(and(candidates, visibleNotes(viewer)))
    .orderBy(asc(note.id))
    .for("no key update", { of: note });
  const proposals = await tx.select({ id: tagProposal.id, noteId: tagProposal.noteId, status: tagProposal.status })
    .from(tagProposal)
    .where(and(candidates, or(isNull(tagProposal.noteId), matchesIds(tagProposal.noteId, lockedNotes.map(({ id }) => id)))))
    .orderBy(asc(tagProposal.id))
    .for("update");
  const proposal = proposals.find(({ id }) => id === proposalId);
  if (!proposal) throw new CommandError("not_found", "This proposal does not exist.");
  if (proposal.status !== "pending") throw new CommandError("invalid", "This proposal was already decided.");
  return proposals;
}

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
  requireMaintainer(actor);
  await db.transaction(async (tx) => {
    const proposals = await lockProposals(tx, actor, proposalId);
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
      .where(matchesIds(tagProposal.id, proposals.map(({ id }) => id)));
    for (const proposal of proposals) {
      if (proposal.noteId) await tx.insert(noteTag).values({ noteId: proposal.noteId, tagId }).onConflictDoNothing();
    }
    await recordAudit(tx, { actorId: actor.personId, action: "tag_proposal.accepted", subjectType: "tag_proposal", subjectId: proposalId, payload: { tagId } });
  });
}

export async function rejectTagProposal(db: Database, actor: Actor, proposalId: string): Promise<void> {
  requireMaintainer(actor);
  await db.transaction(async (tx) => {
    const proposals = await lockProposals(tx, actor, proposalId);
    await tx
      .update(tagProposal)
      .set({ status: "rejected", resolvedById: actor.personId, resolvedAt: new Date() })
      .where(matchesIds(tagProposal.id, proposals.map(({ id }) => id)));
    await recordAudit(tx, { actorId: actor.personId, action: "tag_proposal.rejected", subjectType: "tag_proposal", subjectId: proposalId });
  });
}

/** A name alone, or a name with its description. */
const fileEntry = z.union([nameSchema, z.object({ name: nameSchema, description: descriptionSchema })]);
const entryOf = (entry: z.infer<typeof fileEntry>): ListEntry => (typeof entry === "string" ? { name: entry, description: "" } : entry);

/** The file format of `npm run taxonomy:import`. */
export const taxonomyFileSchema = z.object({
  clusters: z.array(z.object({ name: nameSchema, tags: z.array(fileEntry) })).default([]),
  documentTypes: z.array(fileEntry).default([]),
  topicAreas: z.array(fileEntry).default([]),
});

export type TaxonomyFile = z.infer<typeof taxonomyFileSchema>;

/**
 * Adds what the file lists and is missing; changes and removes nothing. Run
 * again after editing the file: existing names are skipped.
 */
export async function importTaxonomy(db: Database, file: TaxonomyFile) {
  const counts = { clusters: 0, tags: 0, documentTypes: 0, topicAreas: 0 };
  await db.transaction(async (tx) => {
    for (const cluster of file.clusters) {
      const [existing] = await tx.select({ id: tagCluster.id }).from(tagCluster).where(sql`lower(${tagCluster.name}) = lower(${cluster.name})`);
      let clusterId = existing?.id;
      if (!clusterId) {
        clusterId = (await tx.insert(tagCluster).values({ name: cluster.name }).returning({ id: tagCluster.id }))[0]!.id;
        counts.clusters += 1;
      }
      for (const entry of cluster.tags) {
        const { name, description } = entryOf(entry);
        const inserted = await tx
          .insert(tag)
          .values({ name, description, clusterId })
          .onConflictDoNothing()
          .returning({ id: tag.id });
        counts.tags += inserted.length;
      }
    }
    for (const entry of file.documentTypes) {
      counts.documentTypes += (await tx.insert(documentType).values(entryOf(entry)).onConflictDoNothing().returning({ id: documentType.id })).length;
    }
    for (const entry of file.topicAreas) {
      counts.topicAreas += (await tx.insert(topicArea).values(entryOf(entry)).onConflictDoNothing().returning({ id: topicArea.id })).length;
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
    .values(DEFAULT_DOCUMENT_TYPES.map(({ name, description }) => ({ name, description })))
    .onConflictDoNothing()
    .returning({ id: documentType.id });
  return inserted.length;
}

/** Adds the default topic areas when there are none yet. Entries are deactivated, never deleted, so this runs once. */
export async function ensureDefaultTopicAreas(db: Database): Promise<number> {
  const [any] = await db.select({ id: topicArea.id }).from(topicArea).limit(1);
  if (any) return 0;
  const inserted = await db
    .insert(topicArea)
    .values(DEFAULT_TOPIC_AREAS.map(({ name, description }) => ({ name, description })))
    .onConflictDoNothing()
    .returning({ id: topicArea.id });
  return inserted.length;
}
