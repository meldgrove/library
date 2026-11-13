import { describe, expect, it } from "vitest";
import { formatKeyPoints, formatQuotes, noteFormSchema, parseKeyPoints, parseQuotes, parseTagNames } from "./note-input";

describe("note form lists", () => {
  it("reads key points one per line, without bullets", () => {
    expect(parseKeyPoints("- 120 municipalities\n\n• 42 percent\n  Fund staff  ")).toEqual(["120 municipalities", "42 percent", "Fund staff"]);
  });

  it("reads quotes with an optional location, and writes them back", () => {
    const quotes = parseQuotes("“42 percent lack funding” | p. 1\nFund staff, not only projects.");
    expect(quotes).toEqual([{ text: "42 percent lack funding", location: "p. 1" }, { text: "Fund staff, not only projects." }]);
    expect(parseQuotes(formatQuotes(quotes))).toEqual(quotes);
  });

  it("keeps a quote with a line break as one quote through the form", () => {
    const quotes = [{ text: "Heat plans\nneed staff", location: "p. 2" }];
    expect(parseQuotes(formatQuotes(quotes))).toEqual([{ text: "Heat plans need staff", location: "p. 2" }]);
    expect(parseKeyPoints(formatKeyPoints(["One\npoint", "Two"]))).toEqual(["One point", "Two"]);
  });

  it("reads new tag names separated by commas", () => {
    expect(parseTagNames("Heat, heat islands, ,Heat")).toEqual(["Heat", "heat islands"]);
  });
});

describe("noteFormSchema", () => {
  const base = { intent: "publish", title: "T", core: "C", keyPoints: "a\nb\nc", citation: "", language: "EN", visibility: "all", documentTypeId: "", projectId: "" };

  it("normalises the form", () => {
    const parsed = noteFormSchema.parse(base);
    expect(parsed).toMatchObject({ keyPoints: ["a", "b", "c"], quotes: [], language: "en", documentTypeId: null, tagIds: [], newTags: [] });
  });

  it("names the field that is wrong", () => {
    const result = noteFormSchema.safeParse({ ...base, keyPoints: "1\n2\n3\n4\n5\n6\n7\n8", language: "eng" });
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((issue) => issue.path[0])).toEqual(["keyPoints", "language"]);
  });
});
