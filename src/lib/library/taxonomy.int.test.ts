import { eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import { note, noteTag, source, tagProposal } from "@/lib/db/schema";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { viewerOf } from "./access";
import { stewardQueues } from "./review";
import { acceptTagProposal, getTaxonomy, rejectTagProposal } from "./taxonomy";

const testDb = connectTestDatabase();
const db = testDb.db;

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

it("limits the taxonomy and steward counts to notes the steward can see", async () => {
  const { seed, viewer, restricted, visible, standalone } = await setup();
  await db.insert(noteTag).values({ noteId: restricted.id, tagId: seed.tags.budget.id });

  const taxonomy = await getTaxonomy(db, viewer);
  expect(taxonomy.proposals.map(({ id }) => id).sort()).toEqual([visible.id, standalone.id].sort());
  expect(taxonomy.tags.find(({ id }) => id === seed.tags.budget.id)?.notes).toBe(0);
  expect((await stewardQueues(db, viewer)).pendingProposals).toBe(2);
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
