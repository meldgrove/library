import { eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { getCurrentPerson } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { note, source, sourceText, submission } from "@/lib/db/schema";
import { viewerOf } from "@/lib/library/access";
import { createFakeModel } from "@/lib/library/draft";
import { getNoteByNumber } from "@/lib/library/notes";
import { maintenanceQueues } from "@/lib/library/review";
import { processNext } from "@/lib/library/pipeline";
import { listMySubmissions, submitFile, submitLink } from "@/lib/library/submissions";
import { getStorage, type Storage } from "@/lib/storage";
import { connectTestDatabase } from "../../../../../tests/integration/db";
import { seedDirectory } from "../../../../../tests/integration/seed";
import { GET } from "./route";

vi.mock("@/lib/auth/session", () => ({ getCurrentPerson: vi.fn() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({ ...(await importOriginal<object>()), getDb: vi.fn() }));
vi.mock("@/lib/storage", async (importOriginal) => ({ ...(await importOriginal<object>()), getStorage: vi.fn() }));

const testDb = connectTestDatabase();
const db = testDb.db;
afterAll(() => testDb.close());
beforeEach(() => testDb.reset());

it("keeps a stored linked original and its metadata private when someone submits the same link", async () => {
  const { people } = await seedDirectory(db);
  const original = { url: "https://example.org/study?ref=original", reason: "For later", channel: "web" as const };
  const { sourceId, submissionId } = await submitLink(db, { ...original, submitterId: people.ada.id });
  await db.update(submission).set({ status: "parked" }).where(eq(submission.id, submissionId));
  await db.insert(sourceText).values({ sourceId, text: "Text from the original source. ".repeat(10) });
  await db.update(source).set({ detectedTitle: "Original title", storageKey: "fixture", mimeType: "application/pdf" }).where(eq(source.id, sourceId));
  const duplicate = await submitLink(db, { ...original, url: "https://example.org/study", submitterId: people.dan.id });
  expect(duplicate.sourceId).toBe(sourceId);

  const get = vi.fn(async () => new Uint8Array([1, 2, 3]));
  vi.mocked(getDb).mockReturnValue(db);
  vi.mocked(getStorage).mockReturnValue({ get } as unknown as Storage);
  const download = () => GET(new Request("https://library.example.org"), { params: Promise.resolve({ sourceId }) });

  vi.mocked(getCurrentPerson).mockResolvedValue(people.dan);
  expect((await download()).status).toBe(404);
  expect(get).not.toHaveBeenCalled();
  expect(await listMySubmissions(db, viewerOf(people.dan))).toMatchObject([{ url: null, detectedTitle: null }]);

  const model = createFakeModel();
  const complete = vi.spyOn(model, "complete");
  expect(await processNext({ db, model, storage: null, maxBytes: 1024, dailyDraftLimit: 10, ocr: { languages: "eng" } })).toBe("duplicate");
  expect(complete).not.toHaveBeenCalled();

  await db.delete(submission).where(eq(submission.id, submissionId));
  expect((await download()).status).toBe(404);
  expect(await listMySubmissions(db, viewerOf(people.dan))).toMatchObject([{ url: null, detectedTitle: null }]);

  await db.insert(note).values({ sourceId, ownerId: people.ada.id, status: "draft", visibility: "private", title: "Private note", core: "Core" });
  expect((await download()).status).toBe(404);
  vi.mocked(getCurrentPerson).mockResolvedValue(people.ada);
  expect((await download()).status).toBe(200);

  await db.update(submission).set({ status: "parked" }).where(eq(submission.id, duplicate.submissionId));
  expect((await maintenanceQueues(db, viewerOf(people.amy))).onHold).toMatchObject([
    { id: duplicate.submissionId, url: null, fileName: null, hasOriginal: false },
  ]);
});

it("keeps a file original with its first uploader before a note exists", async () => {
  const { people } = await seedDirectory(db);
  const get = vi.fn(async () => new TextEncoder().encode("The shared fixture."));
  const storage: Storage = { kind: "filesystem", get, exists: async () => false, put: vi.fn(), delete: vi.fn() };
  const bytes = await get();
  const input = { channel: "web" as const, reason: "For later", bytes };
  const { sourceId } = await submitFile(db, storage, { ...input, fileName: "first.txt", submitterId: people.ada.id }, 1024);
  await submitFile(db, storage, { ...input, fileName: "second.txt", submitterId: people.dan.id }, 1024);

  vi.mocked(getDb).mockReturnValue(db);
  vi.mocked(getStorage).mockReturnValue(storage);
  const download = () => GET(new Request("https://library.example.org"), { params: Promise.resolve({ sourceId }) });

  vi.mocked(getCurrentPerson).mockResolvedValue(people.dan);
  expect((await download()).status).toBe(404);
  vi.mocked(getCurrentPerson).mockResolvedValue(people.ada);
  expect((await download()).status).toBe(200);
});

it("uses a neutral filename when someone else drafts a note from the same bytes", async () => {
  const { people } = await seedDirectory(db);
  const bytes = new TextEncoder().encode("A study of urban heat and the effect of shade in different neighborhoods. ".repeat(4));
  const storage: Storage = { kind: "filesystem", get: async () => bytes, exists: async () => false, put: vi.fn(), delete: vi.fn() };
  const input = { channel: "web" as const, reason: "For later", bytes };
  const first = await submitFile(db, storage, { ...input, fileName: "first.txt", submitterId: people.ada.id }, 1024);
  await db.update(submission).set({ status: "parked" }).where(eq(submission.id, first.submissionId));
  await submitFile(db, storage, { ...input, fileName: "second.txt", submitterId: people.dan.id }, 1024);

  const model = createFakeModel();
  const complete = vi.spyOn(model, "complete");
  expect(await processNext({ db, model, storage, maxBytes: 1024, dailyDraftLimit: 10, ocr: { languages: "eng" } })).toBe("drafted");
  expect(complete).toHaveBeenCalledOnce();
  expect(JSON.stringify(complete.mock.calls[0])).not.toContain("first.txt");
  const [draft] = await db.select().from(note);
  expect(await getNoteByNumber(db, draft!.number, viewerOf(people.dan))).toMatchObject({ source: { fileName: null } });
  expect(await listMySubmissions(db, viewerOf(people.dan))).toMatchObject([{ fileName: null }]);

  vi.mocked(getDb).mockReturnValue(db);
  vi.mocked(getStorage).mockReturnValue(storage);
  vi.mocked(getCurrentPerson).mockResolvedValue(people.dan);
  const downloaded = await GET(new Request("https://library.example.org"), { params: Promise.resolve({ sourceId: first.sourceId }) });
  expect(downloaded.status).toBe(200);
  expect(downloaded.headers.get("content-disposition")).toContain('filename="source.txt"');
});
