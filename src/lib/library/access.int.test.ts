import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { note, source, submission } from "@/lib/db/schema";
import type { Storage } from "@/lib/storage";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import {
  canEditNote,
  canSeeNote,
  canSeeSource,
  creatingSubmitterOfSource,
  sourceVisibility,
  viewerOf,
  visibleNotes,
  visibleSourceColumns,
  type SourceAccessFields,
  type Viewer,
} from "./access";
import { NOTE_STATUSES, VISIBILITIES, type NoteStatus, type Visibility } from "./constants";
import { getNoteByNumber, listNotes } from "./notes";
import { findOriginal } from "./originals";
import { maintenanceQueues } from "./review";
import { listMySubmissions, submitFile, submitLink } from "./submissions";

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
    // Dan as a maintainer too: the seed has members and an admin.
    const viewers: Viewer[] = [...[seed.people.ada, seed.people.dan, seed.people.amy].map(viewerOf), { ...viewerOf(seed.people.dan), role: "maintainer" }];
    for (const viewer of viewers) {
      const visible = new Set((await db.select({ id: note.id }).from(note).where(visibleNotes(viewer))).map((row) => row.id));
      for (const row of notes) expect(visible.has(row.id), `${viewer.role} ${viewer.personId} · ${row.status} · ${row.visibility} · owner ${row.ownerId === viewer.personId}`).toBe(canSeeNote(viewer, row));
    }
  });

  it("lets maintainers and admins see and edit every note but private ones; members only their own and published ones", () => {
    const draft = { status: "draft", visibility: "team", ownerId: "ada", teamId: "tech" } as const;
    const privateDraft = { ...draft, visibility: "private" } as const;
    const viewer = (role: Viewer["role"]): Viewer => ({ personId: "dan", teamId: "ops", role });
    for (const role of ["maintainer", "admin"] as const) {
      expect([canSeeNote(viewer(role), draft), canEditNote(viewer(role), draft)]).toEqual([true, true]);
      expect([canSeeNote(viewer(role), privateDraft), canEditNote(viewer(role), privateDraft)]).toEqual([false, false]);
    }
    expect([canSeeNote(viewer("member"), draft), canEditNote(viewer("member"), draft)]).toEqual([false, false]);
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

describe("source access", () => {
  const storage: Storage = { kind: "filesystem", get: async () => null, exists: async () => false, put: vi.fn(), delete: vi.fn() };
  const bytes = new TextEncoder().encode("A study of urban heat and the effect of shade in different neighborhoods.");
  const web = { channel: "web" as const, reason: "For later" };

  it("the SQL conditions, the columns, and the page rule agree for every first uploader, note, upload, and viewer", async () => {
    const seed = await seedDirectory(db);
    const { ada, dan, amy } = seed.people;
    const owners = [ada, dan];
    const notes: ({ status: NoteStatus; visibility: Visibility; owner: typeof ada } | null)[] = [null];
    for (const status of NOTE_STATUSES) for (const visibility of VISIBILITIES) for (const owner of owners) notes.push({ status, visibility, owner });
    const cases = new Map<string, { creatorId: string | null; note: SourceAccessFields["note"]; noteId: string | null }>();
    // An upload can be linked to the note of another source with the same DOI.
    const elsewhere = await submitLink(db, { ...web, submitterId: ada.id, url: "https://example.org/matrix/elsewhere" });
    await db.update(source).set({ fileName: "file-0.pdf", detectedTitle: "Title 0", storageKey: "key-0" }).where(eq(source.id, elsewhere.sourceId));
    const elsewhereNote = { status: "published", visibility: "all", ownerId: ada.id, teamId: ada.teamId } as const;
    const [otherNote] = await db.insert(note).values({ sourceId: elsewhere.sourceId, ...elsewhereNote, title: "Elsewhere", core: "Core", publishedAt: new Date() }).returning();
    cases.set(elsewhere.sourceId, { creatorId: ada.id, note: elsewhereNote, noteId: otherNote!.id });
    let index = 0;
    // null: the upload that created the source was deleted.
    for (const creator of [ada, dan, null]) {
      for (const spec of notes) {
        for (const link of spec ? (["none", "this", "other"] as const) : (["none"] as const)) {
          index += 1;
          const url = `https://example.org/matrix/${index}`;
          const created = await submitLink(db, { ...web, submitterId: (creator ?? ada).id, url });
          await db.update(source).set({ fileName: `file-${index}.pdf`, detectedTitle: `Title ${index}`, storageKey: `key-${index}` }).where(eq(source.id, created.sourceId));
          if (!creator) await db.delete(submission).where(eq(submission.id, created.submissionId));
          // A later upload, on hold and not linked to the note, grants nothing.
          const later = await submitLink(db, { ...web, submitterId: amy.id, url });
          await db.update(submission).set({ status: "parked" }).where(eq(submission.id, later.submissionId));
          let target: SourceAccessFields["note"] = null;
          let noteId: string | null = null;
          if (spec) {
            target = { status: spec.status, visibility: spec.visibility, ownerId: spec.owner.id, teamId: spec.owner.teamId };
            const [inserted] = await db.insert(note).values({ sourceId: created.sourceId, ...target, title: `Note ${index}`, core: "Core", publishedAt: spec.status === "published" ? new Date() : null }).returning();
            noteId = inserted!.id;
            if (link !== "none") {
              const linked = await submitLink(db, { ...web, submitterId: dan.id, url });
              await db.update(submission).set({ status: "duplicate", noteId: link === "this" ? noteId : otherNote!.id }).where(eq(submission.id, linked.submissionId));
            }
          }
          cases.set(created.sourceId, { creatorId: creator?.id ?? null, note: target, noteId });
        }
      }
    }

    // Amy as a member of Dan's team, and Dan as a maintainer: the seed has members and an admin.
    const viewers: Viewer[] = [...[ada, dan, amy].map(viewerOf), { ...viewerOf(amy), role: "member" }, { ...viewerOf(dan), role: "maintainer" }];
    for (const viewer of viewers) {
      // Every source is listed with each of its uploads, as in My uploads.
      const can = sourceVisibility(db, viewer, submission);
      const rows = await db
        .select({
          id: source.id,
          uploadNoteId: submission.noteId,
          creatorId: creatingSubmitterOfSource(db),
          url: source.url,
          original: can.original,
          details: can.details,
          reviewLink: can.reviewLink,
          fileName: can.fileName,
          shown: visibleSourceColumns(db, viewer, submission),
        })
        .from(submission)
        .innerJoin(source, eq(source.id, submission.sourceId));
      expect(new Set(rows.map((row) => row.id)).size).toBe(cases.size);
      for (const row of rows) {
        const { noteId, ...known } = cases.get(row.id)!;
        const fields: SourceAccessFields = { ...known, uploadLinked: noteId !== null && row.uploadNoteId === noteId };
        const expected = canSeeSource(viewer, fields);
        const label = `${viewer.role} ${viewer.personId} · ${JSON.stringify(fields)}`;
        expect(row.creatorId, label).toBe(fields.creatorId);
        expect({ original: row.original, details: row.details, reviewLink: row.reviewLink, fileName: row.fileName }, label).toEqual(expected);
        expect(row.shown, label).toEqual({
          fileName: expected.fileName ? expect.stringMatching(/^file-\d+\.pdf$/) : null,
          url: expected.details ? row.url : null,
          detectedTitle: expected.details ? expect.stringMatching(/^Title \d+$/) : null,
          reviewUrl: expected.reviewLink ? row.url : null,
          hasOriginal: expected.original,
        });
      }
    }
  });

  it("grants nothing for a later upload of the same source; the original follows the note", () => {
    const viewer = (personId: string, role: Viewer["role"] = "member"): Viewer => ({ personId, teamId: "ops", role });
    const before = { creatorId: "ada", note: null, uploadLinked: false };
    expect(canSeeSource(viewer("ada"), before)).toEqual({ original: true, details: true, reviewLink: true, fileName: true });
    expect(canSeeSource(viewer("dan"), before)).toEqual({ original: false, details: false, reviewLink: false, fileName: false });
    expect(canSeeSource(viewer("dan", "maintainer"), before)).toEqual({ original: true, details: false, reviewLink: true, fileName: true });
    const danPrivate = { creatorId: "ada", note: { status: "published", visibility: "private", ownerId: "dan", teamId: "ops" }, uploadLinked: true } as const;
    expect(canSeeSource(viewer("ada"), { ...danPrivate, uploadLinked: false })).toEqual({ original: false, details: true, reviewLink: true, fileName: true });
    expect(canSeeSource(viewer("amy", "admin"), danPrivate)).toEqual({ original: false, details: false, reviewLink: false, fileName: false });
    const danForAll = { ...danPrivate, note: { ...danPrivate.note, visibility: "all" }, uploadLinked: false } as const;
    expect(canSeeSource(viewer("amy"), danForAll)).toEqual({ original: true, details: false, reviewLink: false, fileName: false });
    expect(canSeeSource(viewer("amy"), { ...danForAll, uploadLinked: true })).toEqual({ original: true, details: true, reviewLink: true, fileName: false });
  });

  // Behaviour changes when the rule moved into access.ts: each test names what was hidden before.

  it("shows the first uploader their own file name next to another person's note", async () => {
    const { people } = await seedDirectory(db);
    const first = await submitFile(db, storage, { ...web, fileName: "ada-study.txt", bytes, submitterId: people.ada.id }, 1024);
    const second = await submitFile(db, storage, { ...web, fileName: "dan-copy.txt", bytes, submitterId: people.dan.id }, 1024);
    expect(second.sourceId).toBe(first.sourceId);
    const [danNote] = await db.insert(note).values({
      sourceId: first.sourceId, ownerId: people.dan.id, teamId: people.dan.teamId, status: "published", visibility: "all", title: "Dan's note", core: "Core", publishedAt: new Date(),
    }).returning();
    await db.update(submission).set({ status: "duplicate", noteId: danNote!.id }).where(eq(submission.id, first.submissionId));
    const ada = viewerOf(people.ada);

    // Before: null in Ada's uploads and on the note page, and a download named "source.txt".
    expect(await listMySubmissions(db, ada)).toMatchObject([{ id: first.submissionId, fileName: "ada-study.txt", noteNumber: danNote!.number }]);
    expect((await getNoteByNumber(db, danNote!.number, ada))!.source.fileName).toBe("ada-study.txt");
    expect((await findOriginal(db, ada, first.sourceId))!.fileName).toBe("ada-study.txt");
    // Everyone else still sees no file name: the note is Dan's.
    for (const other of [people.dan, people.amy].map(viewerOf)) {
      expect((await getNoteByNumber(db, danNote!.number, other))!.source.fileName).toBeNull();
      expect((await findOriginal(db, other, first.sourceId))!.fileName).toBeNull();
    }
    // A private note keeps the original from the first uploader, but not their file name.
    await db.update(note).set({ visibility: "private" }).where(eq(note.id, danNote!.id));
    expect(await findOriginal(db, ada, first.sourceId)).toBeUndefined();
    expect(await listMySubmissions(db, ada)).toMatchObject([{ id: first.submissionId, fileName: "ada-study.txt", noteNumber: null }]);
  });

  it("shows the saved link and title only to the first uploader and with an upload that was linked to the note", async () => {
    const { people } = await seedDirectory(db);
    const first = await submitLink(db, { ...web, url: "https://example.org/report?ref=ada", submitterId: people.ada.id });
    await db.update(source).set({ detectedTitle: "Heat report" }).where(eq(source.id, first.sourceId));
    // Dan's upload stopped before the note existed, so it is not linked to it.
    const repeat = await submitLink(db, { ...web, url: "https://example.org/report", submitterId: people.dan.id });
    await db.update(submission).set({ status: "duplicate" }).where(eq(submission.id, repeat.submissionId));
    const [adaNote] = await db.insert(note).values({
      sourceId: first.sourceId, ownerId: people.ada.id, teamId: people.ada.teamId, status: "published", visibility: "all", title: "Ada's note", core: "Core", publishedAt: new Date(),
    }).returning();
    const dan = viewerOf(people.dan);
    const dansRows = async () => Object.fromEntries((await listMySubmissions(db, dan)).map((row) => [row.id, row]));
    expect((await dansRows())[repeat.submissionId]).toMatchObject({ url: null, detectedTitle: null, noteNumber: null });

    // An upload of Dan's linked to the note shows both; the unlinked one still does not.
    const linked = await submitLink(db, { ...web, url: "https://example.org/report", submitterId: people.dan.id });
    await db.update(submission).set({ status: "duplicate", noteId: adaNote!.id }).where(eq(submission.id, linked.submissionId));
    expect((await dansRows())[linked.submissionId]).toMatchObject({ url: "https://example.org/report?ref=ada", detectedTitle: "Heat report", noteNumber: adaNote!.number });
    expect((await dansRows())[repeat.submissionId]).toMatchObject({ url: null, detectedTitle: null });
    // A note he may no longer see takes them back.
    await db.update(note).set({ visibility: "private" }).where(eq(note.id, adaNote!.id));
    expect((await dansRows())[linked.submissionId]).toMatchObject({ url: null, detectedTitle: null, noteNumber: null });

    // A maintainer who may see a discarded note gets neither for an upload the worker blocked.
    await db.update(note).set({ status: "discarded", visibility: "all", publishedAt: null }).where(eq(note.id, adaNote!.id));
    const blocked = await submitLink(db, { ...web, url: "https://example.org/report", submitterId: people.amy.id });
    await db.update(submission).set({ status: "blocked" }).where(eq(submission.id, blocked.submissionId));
    expect((await listMySubmissions(db, viewerOf(people.amy)))).toMatchObject([{ id: blocked.submissionId, url: null, detectedTitle: null }]);
  });

  it("shows an upload's file name wherever the person may get the original, as the download names it", async () => {
    const { people } = await seedDirectory(db);
    const amy = viewerOf(people.amy);
    const dan = viewerOf(people.dan);
    const file = await submitFile(db, storage, { ...web, fileName: "ada-plan.txt", bytes, submitterId: people.ada.id }, 1024);
    const fileAgain = await submitFile(db, storage, { ...web, fileName: "amy-plan.txt", bytes, submitterId: people.amy.id }, 1024);
    // Before: null. Maintainers may download an original before there is a note, and the download has the name.
    expect((await listMySubmissions(db, amy)).find((row) => row.id === fileAgain.submissionId)).toMatchObject({ fileName: "ada-plan.txt" });
    expect((await findOriginal(db, amy, file.sourceId))!.fileName).toBe("ada-plan.txt");

    // Before: null. Dan's upload is not linked to Ada's note, but he may see the note and download the original.
    const danAgain = await submitFile(db, storage, { ...web, fileName: "dan-plan.txt", bytes, submitterId: people.dan.id }, 1024);
    await db.update(submission).set({ status: "duplicate" }).where(eq(submission.id, danAgain.submissionId));
    expect((await listMySubmissions(db, dan)).find((row) => row.id === danAgain.submissionId)).toMatchObject({ fileName: null });
    await db.insert(note).values({
      sourceId: file.sourceId, ownerId: people.ada.id, teamId: people.ada.teamId, status: "published", visibility: "all", title: "Ada's plan", core: "Core", publishedAt: new Date(),
    });
    expect((await listMySubmissions(db, dan)).find((row) => row.id === danAgain.submissionId)).toMatchObject({ fileName: "ada-plan.txt", detectedTitle: null });
    expect((await findOriginal(db, dan, file.sourceId))!.fileName).toBe("ada-plan.txt");
  });

  it("keeps the saved link and title of a source without a note from a maintainer's later upload, also while it is on hold", async () => {
    const { people } = await seedDirectory(db);
    const amy = viewerOf(people.amy);
    const link = await submitLink(db, { ...web, url: "https://example.org/plan?ref=ada", submitterId: people.ada.id });
    await db.update(source).set({ detectedTitle: "Heat plan" }).where(eq(source.id, link.sourceId));
    const linkAgain = await submitLink(db, { ...web, url: "https://example.org/plan", submitterId: people.amy.id });
    const amysLink = async () => (await listMySubmissions(db, amy)).find((row) => row.id === linkAgain.submissionId);
    expect(await amysLink()).toMatchObject({ url: null, detectedTitle: null });
    await db.update(submission).set({ status: "parked" }).where(eq(submission.id, link.submissionId));
    expect(await amysLink()).toMatchObject({ url: null, detectedTitle: null });
    // The maintenance queue shows the link of the upload on hold, as before.
    expect((await maintenanceQueues(db, amy)).onHold).toMatchObject([{ id: link.submissionId, url: "https://example.org/plan?ref=ada" }]);
  });
});
