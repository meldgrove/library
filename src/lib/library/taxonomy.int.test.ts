import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvent, documentType, note, noteTag, source, tag, tagCluster, tagProposal, topicArea } from "@/lib/db/schema";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { viewerOf } from "./access";
import { maintenanceQueues, recordReviewReminders } from "./review";
import {
  acceptTagProposal,
  createCluster,
  createTopicArea,
  DEFAULT_DOCUMENT_TYPES,
  DEFAULT_TOPIC_AREAS,
  deleteCluster,
  draftLists,
  ensureDefaultDocumentTypes,
  ensureDefaultTopicAreas,
  getTaxonomy,
  importTaxonomy,
  rejectTagProposal,
  renameCluster,
  setTopicAreaActive,
  taxonomyFileSchema,
  updateDocumentType,
  updateTopicArea,
} from "./taxonomy";

const testDb = connectTestDatabase();
const db = testDb.db;
let seed: Awaited<ReturnType<typeof seedDirectory>>;

beforeEach(() => testDb.reset());
afterAll(() => testDb.close());

async function setup() {
  const seed = await seedDirectory(db);
  const sources = await db.insert(source).values([
    { kind: "link", url: "https://example.org/public" },
    { kind: "link", url: "https://example.org/private" },
  ]).returning();
  const [shared, restricted] = await db.insert(note).values([
    { sourceId: sources[0]!.id, ownerId: seed.people.ada.id, visibility: "all", title: "Shared note", core: "Summary" },
    { sourceId: sources[1]!.id, ownerId: seed.people.ada.id, visibility: "private", title: "Private note", core: "Summary" },
  ]).returning();
  const [visible, hidden, standalone] = await db.insert(tagProposal).values([
    { noteId: shared!.id, name: "Heat islands" },
    { noteId: restricted!.id, name: "HEAT ISLANDS" },
    { name: "Heat Islands" },
  ]).returning();
  return { seed, viewer: viewerOf(seed.people.amy), shared: shared!, restricted: restricted!, visible: visible!, hidden: hidden!, standalone: standalone! };
}

it("limits the taxonomy and maintenance counts to notes the maintainer can see", async () => {
  const { seed, viewer, restricted, visible, standalone } = await setup();
  await db.insert(noteTag).values({ noteId: restricted.id, tagId: seed.tags.budget.id });

  const taxonomy = await getTaxonomy(db, viewer);
  expect(taxonomy.proposals.map(({ id }) => id).sort()).toEqual([visible.id, standalone.id].sort());
  expect(taxonomy.tags.find(({ id }) => id === seed.tags.budget.id)?.notes).toBe(0);
  expect((await maintenanceQueues(db, viewer)).pendingProposals).toBe(2);
});

it.each(["accept", "reject"] as const)("can %s matching proposals only for visible notes", async (decision) => {
  const { seed, restricted, shared, visible, hidden, standalone } = await setup();
  const resolve = (proposalId: string) => decision === "accept"
    ? acceptTagProposal(db, seed.actors.amy, proposalId, { existingTagId: seed.tags.budget.id })
    : rejectTagProposal(db, seed.actors.amy, proposalId);

  await expect(resolve(hidden.id)).rejects.toMatchObject({ code: "not_found" });
  await resolve(visible.id);
  await expect(resolve(standalone.id)).rejects.toMatchObject({ code: "invalid" });
  const [stillPending] = await db.select().from(tagProposal).where(eq(tagProposal.id, hidden.id));
  expect(stillPending).toMatchObject({ status: "pending", tagId: null, resolvedById: null });
  expect(await db.select({ noteId: noteTag.noteId }).from(noteTag)).toEqual(decision === "accept" ? [{ noteId: shared.id }] : []);

  await db.update(note).set({ visibility: "team" }).where(eq(note.id, restricted.id));
  await resolve(hidden.id);
  const [resolved] = await db.select().from(tagProposal).where(eq(tagProposal.id, hidden.id));
  expect(resolved?.status).toBe(decision === "accept" ? "accepted" : "rejected");
});

it("can accept proposals while the reminder job updates the same notes", async () => {
  const { seed, restricted, shared, visible } = await setup();
  const draftedAt = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-03-01T00:00:00Z");
  await db.update(note).set({ draftedAt, reminderSentAt: draftedAt }).where(eq(note.id, shared.id));
  await db.update(note).set({ draftedAt, visibility: "all" }).where(eq(note.id, restricted.id));

  const [reminders] = await Promise.all([
    recordReviewReminders(db, now),
    acceptTagProposal(db, seed.actors.amy, visible.id, { existingTagId: seed.tags.budget.id }),
  ]);
  expect(reminders).toEqual({ reminded: 1, escalated: 2 });
  expect(await db.select().from(noteTag)).toHaveLength(2);
});

describe("clusters", () => {
  beforeEach(async () => {
    seed = await seedDirectory(db);
  });

  it("renames a cluster, but not to a name in use", async () => {
    const climate = await createCluster(db, seed.actors.amy, "Climate");
    await createCluster(db, seed.actors.amy, "Funding");
    await renameCluster(db, seed.actors.amy, climate, "Climate and energy");
    expect((await db.select().from(tagCluster).where(eq(tagCluster.id, climate)))[0]?.name).toBe("Climate and energy");
    await expect(renameCluster(db, seed.actors.amy, climate, "funding")).rejects.toMatchObject({ fieldErrors: { name: "This name exists already." } });
  });

  it("deletes a cluster and keeps its tags, without a cluster", async () => {
    const money = await createCluster(db, seed.actors.amy, "Money");
    await db.update(tag).set({ clusterId: money }).where(eq(tag.id, seed.tags.budget.id));
    await expect(deleteCluster(db, seed.actors.ada, money)).rejects.toMatchObject({ code: "forbidden" });
    await deleteCluster(db, seed.actors.amy, money);
    expect(await db.select().from(tagCluster)).toEqual([]);
    expect((await db.select().from(tag).where(eq(tag.id, seed.tags.budget.id)))[0]).toMatchObject({ name: "Budget", clusterId: null });
    const events = await db.select().from(auditEvent).where(eq(auditEvent.subjectId, money));
    expect(events.map((event) => event.payload)).toContainEqual({ change: "deleted", name: "Money", tags: 1 });
  });
});

describe("topic areas and document types", () => {
  beforeEach(async () => {
    seed = await seedDirectory(db);
  });

  it("gives the AI model the active entries with their descriptions", async () => {
    await ensureDefaultDocumentTypes(db);
    const area = await createTopicArea(db, seed.actors.amy, { name: "Climate", description: "" });
    await createTopicArea(db, seed.actors.amy, { name: "Health", description: "Health and care" });
    await updateTopicArea(db, seed.actors.amy, area, { name: "Climate and environment", description: "Climate change and nature" });
    const [study] = await db.select().from(documentType).where(eq(documentType.name, "Study"));
    await updateDocumentType(db, seed.actors.amy, study!.id, { name: "Research study", description: "Own data or analysis" });
    await setTopicAreaActive(db, seed.actors.amy, area, false);

    const lists = await draftLists(db);
    expect(lists.topicAreas).toEqual([{ name: "Health", description: "Health and care" }]);
    expect(lists.documentTypes).toContainEqual({ name: "Research study", description: "Own data or analysis" });
    expect(lists.documentTypes.map((type) => type.name)).not.toContain("Study");
  });

  it("refuses changes from people who are not maintainers, and names in use", async () => {
    await expect(createTopicArea(db, seed.actors.ada, { name: "Climate", description: "" })).rejects.toMatchObject({ code: "forbidden" });
    const area = await createTopicArea(db, seed.actors.amy, { name: "Climate", description: "" });
    await createTopicArea(db, seed.actors.amy, { name: "Health", description: "" });
    await expect(updateTopicArea(db, seed.actors.amy, area, { name: "HEALTH", description: "" })).rejects.toMatchObject({ fieldErrors: { name: "This name exists already." } });
  });

  it("adds the default document types with descriptions, only while there are none", async () => {
    expect(await ensureDefaultDocumentTypes(db)).toBe(DEFAULT_DOCUMENT_TYPES.length);
    expect(await ensureDefaultDocumentTypes(db)).toBe(0);
    const types = await db.select().from(documentType);
    expect(types.map((type) => type.name)).toEqual(expect.arrayContaining(["Podcast", "Transcript", "Social media post"]));
    expect(types.every((type) => type.description.length > 0)).toBe(true);
  });

  it("adds the default topic areas with descriptions, only while there are none", async () => {
    expect(await ensureDefaultTopicAreas(db)).toBe(DEFAULT_TOPIC_AREAS.length);
    const area = (await db.select().from(topicArea)).find((row) => row.name === "Paludiculture")!;
    await updateTopicArea(db, seed.actors.amy, area.id, { name: "Peatland farming", description: area.description });
    await setTopicAreaActive(db, seed.actors.amy, area.id, false);
    // Changed and deactivated entries stay as the maintainers left them.
    expect(await ensureDefaultTopicAreas(db)).toBe(0);
    const lists = await draftLists(db);
    expect(lists.topicAreas).toHaveLength(DEFAULT_TOPIC_AREAS.length - 1);
    expect(lists.topicAreas.map((entry) => entry.name)).not.toContain("Paludiculture");
    expect(lists.topicAreas.every((entry) => entry.description.length > 0)).toBe(true);
  });

  it("imports topic areas and document types, with or without a description, and adds only what is missing", async () => {
    const file = taxonomyFileSchema.parse({
      topicAreas: ["Health", { name: "Climate", description: "Climate change and nature" }],
      documentTypes: [{ name: "Toolkit", description: "Templates for practitioners" }],
    });
    expect(await importTaxonomy(db, file)).toEqual({ clusters: 0, tags: 0, documentTypes: 1, topicAreas: 2 });
    expect(await importTaxonomy(db, file)).toEqual({ clusters: 0, tags: 0, documentTypes: 0, topicAreas: 0 });
    expect((await draftLists(db)).topicAreas).toEqual([
      { name: "Climate", description: "Climate change and nature" },
      { name: "Health", description: "" },
    ]);
  });
});
