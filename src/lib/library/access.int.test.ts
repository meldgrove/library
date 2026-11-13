import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { note, source } from "@/lib/db/schema";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { canSeeNote, viewerOf, visibleNotes } from "./access";
import { NOTE_STATUSES, VISIBILITIES } from "./constants";
import { listNotes } from "./notes";

const testDb = connectTestDatabase();
const db = testDb.db;

afterAll(() => testDb.close());
beforeEach(() => testDb.reset());

describe("note access", () => {
  it("the SQL condition and the page rule agree for every status, visibility, and viewer", async () => {
    const seed = await seedDirectory(db);
    const owners = [seed.people.ada, seed.people.dan];
    let index = 0;
    for (const owner of owners) {
      for (const status of NOTE_STATUSES) {
        for (const visibility of VISIBILITIES) {
          index += 1;
          const [src] = await db.insert(source).values({ kind: "link", url: `https://example.org/${index}`, normalizedUrl: `https://example.org/${index}` }).returning();
          await db.insert(note).values({
            sourceId: src!.id,
            ownerId: owner.id,
            teamId: owner.teamId,
            status,
            visibility,
            title: `Note ${index}`,
            core: "Core",
            publishedAt: status === "published" ? new Date() : null,
          });
        }
      }
    }
    const notes = await db.select().from(note);
    for (const person of [seed.people.ada, seed.people.dan, seed.people.amy]) {
      const viewer = viewerOf(person);
      const visible = new Set((await db.select({ id: note.id }).from(note).where(visibleNotes(viewer))).map((row) => row.id));
      for (const row of notes) expect(visible.has(row.id), `${person.displayName} · ${row.status} · ${row.visibility} · owner ${row.ownerId === person.id}`).toBe(canSeeNote(viewer, row));
    }
  });

  it("lists only published notes the viewer may see, and searches them", async () => {
    const seed = await seedDirectory(db);
    const make = async (title: string, visibility: "all" | "team" | "private", owner = seed.people.ada) => {
      const [src] = await db.insert(source).values({ kind: "link", url: `https://example.org/${title}`, normalizedUrl: `https://example.org/${title}` }).returning();
      await db.insert(note).values({ sourceId: src!.id, ownerId: owner.id, teamId: owner.teamId, status: "published", visibility, title, core: `About ${title} and Hitzeschutz`, publishedAt: new Date() });
    };
    await make("Public heat", "all");
    await make("Team heat", "team");
    await make("Private heat", "private");
    const dan = viewerOf(seed.people.dan);
    expect((await listNotes(db, dan)).notes.map((n) => n.title)).toEqual(["Public heat"]);
    expect((await listNotes(db, viewerOf(seed.people.ada))).total).toBe(3);
    expect((await listNotes(db, viewerOf(seed.people.ada), { q: "hitzeschutz" })).total).toBe(3);
    expect((await listNotes(db, viewerOf(seed.people.ada), { q: "private" })).notes.map((n) => n.title)).toEqual(["Private heat"]);
    expect((await listNotes(db, dan, { q: "private" })).total).toBe(0);
    expect(await db.select().from(note).where(eq(note.title, "Team heat"))).toHaveLength(1);
  });
});
