import type { NoteQuote } from "./constants";

/*
 * Derived text of a note: what full-text search indexes besides title and
 * core, and the snapshot each version keeps. Pure functions.
 */

export function noteSearchText(fields: { keyPoints: string[]; quotes: NoteQuote[]; citation: string; tagNames: string[] }): string {
  return [...fields.keyPoints, ...fields.quotes.map((quote) => quote.text), fields.citation, ...fields.tagNames].join("\n");
}

/** The fields a version keeps; IDs of lists, names of tags. */
export function snapshotOf(fields: {
  title: string;
  core: string;
  keyPoints: string[];
  quotes: NoteQuote[];
  citation: string;
  language: string | null;
  visibility: string;
  documentTypeId: string | null;
  projectId: string | null;
  tagNames: string[];
}): Record<string, unknown> {
  return {
    title: fields.title,
    core: fields.core,
    keyPoints: fields.keyPoints,
    quotes: fields.quotes,
    citation: fields.citation,
    language: fields.language,
    visibility: fields.visibility,
    documentTypeId: fields.documentTypeId,
    projectId: fields.projectId,
    tags: [...fields.tagNames].sort((a, b) => a.localeCompare(b)),
  };
}
