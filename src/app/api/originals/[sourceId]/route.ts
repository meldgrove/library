import { and, eq } from "drizzle-orm";
import { getCurrentPerson } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { note, source, submission } from "@/lib/db/schema";
import { canSeeNote, viewerOf } from "@/lib/library/access";
import { getStorage } from "@/lib/storage";

/*
 * The original file of a source, for people who may see its note or who
 * uploaded it. PDFs open in the browser; every other file is downloaded. The
 * sandbox policy keeps a crafted file from running scripts on this origin.
 */

const notFound = () => new Response("Not found", { status: 404 });

const asciiName = (name: string) => name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");

export async function GET(_request: Request, { params }: RouteContext<"/api/originals/[sourceId]">) {
  const person = await getCurrentPerson();
  if (!person) return new Response("Sign in first", { status: 401 });
  const { sourceId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) return notFound();
  const db = getDb();
  const [row] = await db.select().from(source).where(eq(source.id, sourceId));
  if (!row?.storageKey) return notFound();

  const [ownNote] = await db
    .select({ status: note.status, visibility: note.visibility, ownerId: note.ownerId, teamId: note.teamId })
    .from(note)
    .where(eq(note.sourceId, sourceId));
  const uploaded = await db
    .select({ id: submission.id })
    .from(submission)
    .where(and(eq(submission.sourceId, sourceId), eq(submission.submitterId, person.id)))
    .limit(1);
  const allowed = uploaded.length > 0 || (ownNote !== undefined && canSeeNote(viewerOf(person), ownNote)) || (person.isAdmin && !ownNote);
  if (!allowed) return notFound();

  const bytes = await getStorage().get(row.storageKey);
  if (!bytes) return notFound();
  const pdf = row.mimeType === "application/pdf";
  const fileName = row.fileName ?? (pdf ? "source.pdf" : "source");
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
