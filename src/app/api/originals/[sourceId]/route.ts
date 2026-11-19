import { and, eq, isNull, or } from "drizzle-orm";
import { canMaintain } from "@/lib/auth/roles";
import { getCurrentPerson } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { note, source } from "@/lib/db/schema";
import { creatingSubmitterOfSource, noteSourceFileName, viewerOf, visibleNotes } from "@/lib/library/access";
import { ACCEPTED_TYPES } from "@/lib/library/file-types";
import { getStorage } from "@/lib/storage";

/*
 * The original file follows its note's visibility. Before a note exists,
 * the file is available to the first uploader and maintainers. PDFs open in
 * the browser; other files are downloaded. The sandbox policy keeps a
 * crafted file from running scripts on this origin.
 */

const notFound = () => new Response("Not found", { status: 404 });

const asciiName = (name: string) => name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");

export async function GET(_request: Request, { params }: RouteContext<"/api/originals/[sourceId]">) {
  const person = await getCurrentPerson();
  if (!person) return new Response("Sign in first", { status: 401 });
  const { sourceId } = await params;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sourceId)) return notFound();
  const db = getDb();
  const beforeNote = and(isNull(note.id), canMaintain(person.role) ? undefined : eq(creatingSubmitterOfSource(db), person.id));
  const [row] = await db
    .select({ storageKey: source.storageKey, mimeType: source.mimeType, fileName: noteSourceFileName(db) })
    .from(source)
    .leftJoin(note, eq(note.sourceId, source.id))
    .where(and(
      eq(source.id, sourceId),
      or(visibleNotes(viewerOf(person)), beforeNote),
    ));
  if (!row?.storageKey) return notFound();

  const bytes = (await getStorage()?.get(row.storageKey)) ?? null;
  if (!bytes) return notFound();
  const pdf = row.mimeType === ACCEPTED_TYPES.pdf.mimeType;
  const extension = Object.values(ACCEPTED_TYPES).find(({ mimeType }) => mimeType === row.mimeType)?.extensions[0] ?? "";
  const fileName = row.fileName ?? `source${extension}`;
  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": pdf ? "application/pdf" : "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "content-disposition": `${pdf ? "inline" : "attachment"}; filename="${asciiName(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "content-security-policy": "sandbox; default-src 'none'; object-src 'self'",
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
