import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * The replay script runs on import. Everything around the AI model and the
 * database is replaced, so the test sees the text the model would get.
 */
const mocks = vi.hoisted(() => ({
  draftNote: vi.fn(async () => ({ tags: [], documentType: null, topicArea: null })),
  fetchLink: vi.fn(),
  end: vi.fn(async () => {}),
}));
vi.mock("@/lib/config", () => ({
  getAiConfig: () => ({}),
  getDatabaseConfig: () => ({}),
  getOcrConfig: () => ({ OCR_LANGUAGES: "eng" }),
  getUploadConfig: () => ({ UPLOAD_MAX_MB: 1 }),
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}), getPool: () => ({ end: mocks.end }) }));
vi.mock("@/lib/library/draft", () => ({ createDraftModel: () => ({}), draftNote: mocks.draftNote }));
vi.mock("@/lib/library/fetch-link", () => ({ fetchLink: mocks.fetchLink }));
vi.mock("@/lib/library/taxonomy", () => ({ draftLists: async () => ({}) }));

let directory: string;
const argv = process.argv;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "library-replay-"));
});

afterAll(async () => {
  process.argv = argv;
  await rm(directory, { recursive: true, force: true });
});

describe("replay script", () => {
  it("reads a linked web page as the pipeline does", async () => {
    // A page in Windows-1252, as older sites still send them.
    const page = `<html><head><title>Hitze</title></head><body><article><p>${"Straßen und Plätze werden heißer. ".repeat(10)}</p></article></body></html>`;
    mocks.fetchLink.mockResolvedValue({ url: "https://example.org/hitze", contentType: "text/html", bytes: new Uint8Array(Buffer.from(page, "latin1")) });
    const set = path.join(directory, "set.json");
    await writeFile(set, JSON.stringify({ items: [{ url: "https://example.org/hitze", expected: { tags: [] } }] }));
    process.argv = [argv[0]!, "replay", set];
    vi.spyOn(console, "log").mockImplementation(() => {});

    await import("./replay");
    await vi.waitFor(() => expect(mocks.end).toHaveBeenCalled());

    expect(mocks.draftNote).toHaveBeenCalledWith({}, expect.objectContaining({ text: expect.stringContaining("Straßen und Plätze werden heißer.") }));
  });
});
