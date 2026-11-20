import type { SearchResult } from "@meldgrove/ui/app-frame";
import type { NoteSearchResult } from "./constants";

/*
 * The notes for the frame's search (⌘K). Runs in the browser: it asks
 * /api/search, which answers only with published notes the person may see.
 */

/** The library filtered by a search: "Show all results". */
export const libraryHref = (q: string) => `/?${new URLSearchParams({ q })}`;

/**
 * Notes for a query: from two characters on, or one digit, so "7" finds
 * LIB-7. Shorter queries show only the app's pages.
 */
export async function findNotes(query: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<SearchResult[]> {
  const term = query.trim();
  if (term.length < 2 && !/^\d$/.test(term)) return [];
  const response = await request(`/api/search?${new URLSearchParams({ q: term })}`, { signal });
  if (!response.ok) throw new Error(`The search answered ${response.status}.`);
  const { results } = (await response.json()) as { results: NoteSearchResult[] };
  return results.map(({ ref, title, kind, href }) => ({ href, title, reference: ref, kind: kind ?? undefined }));
}
