import { describe, expect, it } from "vitest";
import { noteRef, parseNoteNumber, parseNoteRef } from "./constants";

describe("note references", () => {
  it("reads a note path segment", () => {
    expect(parseNoteNumber("12")).toBe(12);
    expect(parseNoteNumber("12a")).toBeUndefined();
    expect(parseNoteNumber("LIB-12")).toBeUndefined();
  });

  it("reads a reference typed into the search", () => {
    expect(parseNoteRef(noteRef(12))).toBe(12);
    expect(parseNoteRef(" lib 7 ")).toBe(7);
    expect(parseNoteRef("lib7")).toBe(7);
    expect(parseNoteRef("42")).toBe(42);
    expect(parseNoteRef("library 7")).toBeUndefined();
    expect(parseNoteRef("heat 2026")).toBeUndefined();
  });
});
