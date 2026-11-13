import { getCurrentPerson } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { viewerOf } from "@/lib/library/access";
import { notePath, noteRef, parseNoteRef, type NoteSearchResult } from "@/lib/library/constants";
import { listNotes } from "@/lib/library/notes";

// The search in the sidebar (⌘K): published notes the person may see, by
// text or by a reference such as LIB-12. Answers 401 instead of redirecting.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const LIMIT = 8;

export async function GET(request: Request): Promise<Response> {
  const person = await getCurrentPerson();
  if (!person) return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 200);
  if (!q) return Response.json({ results: [] }, { headers: NO_STORE });
  const db = getDb();
  const viewer = viewerOf(person);
  const number = parseNoteRef(q);
  const [byRef, byText] = await Promise.all([
    number === undefined ? Promise.resolve({ notes: [] }) : listNotes(db, viewer, { number, limit: 1 }),
    listNotes(db, viewer, { q, limit: LIMIT }),
  ]);
  const seen = new Set<string>();
  const results: NoteSearchResult[] = [...byRef.notes, ...byText.notes]
    .filter((item) => !seen.has(item.id) && seen.add(item.id))
    .slice(0, LIMIT)
    .map((item) => ({ ref: noteRef(item.number), title: item.title, kind: item.documentTypeName, href: notePath(item.number) }));
  return Response.json({ results }, { headers: NO_STORE });
}
