import { describe, expect, it } from "vitest";
import { noteChangedPayload, noteRemovedPayload, payloadHash, type NoteForWebhook } from "./payload";

const NOTE: NoteForWebhook = {
  id: "0195f0a0-0000-7000-8000-000000000001",
  number: 12,
  title: "Municipal climate adaptation",
  core: "Most municipalities lack funding for heat plans.",
  keyPoints: ["120 municipalities surveyed", "42 percent lack funding"],
  quotes: [{ text: "42 percent lack funding", location: "p. 1" }, { text: "Heat kills" }],
  citation: "Example Institute (2025)",
  language: "en",
  visibility: "all",
  publishedAt: new Date("2026-11-10T10:00:00Z"),
  editedAt: null,
  team: { name: "Climate", directoryId: "kc-group-1" },
  ownerName: "Erika Employee",
  documentType: "Study",
  project: null,
  tags: ["Climate", "Funding"],
  sourceUrl: null,
  doi: "10.1234/x",
  checked: false,
};

describe("noteChangedPayload", () => {
  it("sends the whole note, keyed by its ID, with a link and one readable text", () => {
    const payload = noteChangedPayload(NOTE, "https://library.example/");
    expect(payload).toMatchObject({
      event: "note.changed",
      note: {
        id: NOTE.id,
        ref: "LIB-12",
        url: "https://library.example/n/12",
        title: "Municipal climate adaptation",
        key_points: ["120 municipalities surveyed", "42 percent lack funding"],
        quotes: [
          { text: "42 percent lack funding", location: "p. 1" },
          { text: "Heat kills", location: null },
        ],
        visibility: "all",
        team: { name: "Climate", directory_id: "kc-group-1" },
        owner: "Erika Employee",
        tags: ["Climate", "Funding"],
        ai_drafted: true,
        published_at: "2026-11-10T10:00:00.000Z",
        changed_at: "2026-11-10T10:00:00.000Z",
      },
    });
    expect(payload.note.text).toContain("Key points:\n- 120 municipalities surveyed");
    expect(payload.note.text).toContain('- "42 percent lack funding" (p. 1)');
    expect(payload.note.text).toContain("confirmed by Erika Employee. Check details against the source.");
  });

  it("reports the last edit as the change time", () => {
    const edited = noteChangedPayload({ ...NOTE, editedAt: new Date("2026-11-12T08:00:00Z") }, "https://library.example");
    expect(edited.note.changed_at).toBe("2026-11-12T08:00:00.000Z");
  });

  it("changes its hash only when the content changes", () => {
    const a = noteChangedPayload(NOTE, "https://library.example");
    expect(payloadHash(a)).toBe(payloadHash(JSON.parse(JSON.stringify(a))));
    expect(payloadHash(a)).not.toBe(payloadHash(noteChangedPayload({ ...NOTE, checked: true }, "https://library.example")));
  });
});

describe("noteRemovedPayload", () => {
  it("names only the note", () => {
    expect(noteRemovedPayload(NOTE.id)).toEqual({ event: "note.removed", note: { id: NOTE.id } });
  });
});
