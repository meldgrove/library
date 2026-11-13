import { describe, expect, it } from "vitest";
import { buildDigestMessage, digestWindow, DIGEST_MAX_ITEMS, type DigestNote } from "./digest";

const at = (day: number) => new Date(`2026-11-${String(day).padStart(2, "0")}T10:00:00Z`);
const digestNote = (overrides: Partial<DigestNote> & { number: number }): DigestNote => ({
  title: `Note ${overrides.number}`,
  core: "The core in two sentences. It says what matters.",
  quotes: [],
  publishedAt: at(10),
  documentType: null,
  tags: [],
  ...overrides,
});

describe("buildDigestMessage", () => {
  it("is null without notes", () => {
    expect(buildDigestMessage([])).toBeNull();
  });

  it("groups notes by the cluster of their first tag, with Other last", () => {
    const message = buildDigestMessage([
      digestNote({ number: 1, publishedAt: at(9), tags: [{ name: "Heat", cluster: "Climate" }, { name: "Budgets", cluster: "Funding" }], documentType: "Study" }),
      digestNote({ number: 2, publishedAt: at(11), tags: [{ name: "Water", cluster: "Climate" }] }),
      digestNote({ number: 3, publishedAt: at(10), tags: [{ name: "Loose", cluster: null }] }),
      digestNote({ number: 4, publishedAt: at(12) }),
      digestNote({ number: 5, publishedAt: at(8), tags: [{ name: "Grants", cluster: "Funding" }] }),
    ])!;
    expect(message.sections!.map((section) => [section.heading, section.items.map((item) => item.ref)])).toEqual([
      // "Budgets" comes before "Heat", so note 1 is under Funding.
      ["Climate", ["LIB-2"]],
      ["Funding", ["LIB-1", "LIB-5"]],
      ["Other", ["LIB-4", "LIB-3"]],
    ]);
    expect(message.sections![1]!.items[0]).toEqual({
      ref: "LIB-1",
      title: "Note 1",
      path: "/n/1",
      summary: "The core in two sentences. It says what matters.",
      meta: "Study · Budgets, Heat",
    });
    expect(message.sections![2]!.items[0]).not.toHaveProperty("meta");
    expect(message).toMatchObject({ subject: "Library digest: 5 new notes", title: "Weekly library digest", path: "/" });
    expect(message.text).toBe("5 new notes were published in the library last week.");
  });

  it("quotes the newest note that has a quote", () => {
    const message = buildDigestMessage(
      [
        digestNote({ number: 1, publishedAt: at(9), quotes: [{ text: "Older quote" }] }),
        digestNote({ number: 2, publishedAt: at(11), title: "Shade", quotes: [{ text: "Shade  saves\nlives.", location: "p. 4" }, { text: "Second" }] }),
        digestNote({ number: 3, publishedAt: at(12) }),
      ],
      { audience: "by Engineering" },
    )!;
    expect(message.text.split("\n")).toEqual([
      "3 new notes were published in the library last week by Engineering.",
      "Quote of the week: “Shade saves lives.” (LIB-2 · Shade)",
    ]);
  });

  it("shortens long cores and lists only the newest notes", () => {
    const many = Array.from({ length: DIGEST_MAX_ITEMS + 3 }, (_, i) => digestNote({ number: i + 1, publishedAt: new Date(at(1).getTime() + i * 60_000), core: "word ".repeat(100) }));
    const message = buildDigestMessage(many)!;
    const items = message.sections!.flatMap((section) => section.items);
    expect(items).toHaveLength(DIGEST_MAX_ITEMS);
    expect(items[0]!.ref).toBe(`LIB-${DIGEST_MAX_ITEMS + 3}`);
    expect(items[0]!.summary.length).toBeLessThanOrEqual(280);
    expect(items[0]!.summary.endsWith("…")).toBe(true);
    expect(message.text).toContain(`The ${DIGEST_MAX_ITEMS} newest are listed here`);
    expect(buildDigestMessage([digestNote({ number: 1 })])!.text).toBe("1 new note was published in the library last week.");
  });
});


describe("digestWindow", () => {
  // Tests run in Europe/Amsterdam; clocks went back on Sunday 25 October 2026.
  it("runs from one Monday 09:00 to the next, also across a clock change", () => {
    const window = digestWindow(new Date("2026-10-26T08:30:00Z"));
    expect(window).toEqual({ since: new Date("2026-10-19T07:00:00Z"), until: new Date("2026-10-26T08:00:00Z"), week: "2026-W44" });
    expect((window.until.getTime() - window.since.getTime()) / 3_600_000).toBe(169);
  });

  it("keeps the week's window for a run later in the week, and takes the week before until Monday 09:00", () => {
    expect(digestWindow(new Date("2026-11-19T15:00:00Z"))).toEqual(digestWindow(new Date("2026-11-16T08:00:00Z")));
    expect(digestWindow(new Date("2026-11-16T07:59:00Z"))).toMatchObject({ until: new Date("2026-11-09T08:00:00Z"), week: "2026-W46" });
    expect(digestWindow(new Date("2026-11-16T08:00:00Z")).week).toBe("2026-W47");
  });
});
