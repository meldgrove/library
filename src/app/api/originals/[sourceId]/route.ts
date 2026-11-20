import { getCurrentPerson } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { viewerOf } from "@/lib/library/access";
import { ACCEPTED_TYPES } from "@/lib/library/file-types";
import { findOriginal } from "@/lib/library/originals";
import { getStorage } from "@/lib/storage";

/*
 * The original file, for those who may get it (`canSeeSource` in
 * `access.ts`). PDFs open in the browser; other files are downloaded. The
 * sandbox policy keeps a crafted file from running scripts on this origin.
 */

const notFound = () => new Response("Not found", { status: 404 });

const asciiName = (name: string) => name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");

export async function GET(_request: Request, { params }: RouteContext<"/api/originals/[sourceId]">) {
  const person = await getCurrentPerson();
  if (!person) return new Response("Sign in first", { status: 401 });
  const { sourceId } = await params;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sourceId)) return notFound();
  const row = await findOriginal(getDb(), viewerOf(person), sourceId);
  if (!row) return notFound();

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
