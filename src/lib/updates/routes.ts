import { getCurrentPerson } from "@/lib/auth/session";
import { getAuthConfig } from "@/lib/config";
import type { PersonRow } from "@/lib/directory/queries";
import type { UpdatesResult } from "./updater";

const NO_STORE = { "Cache-Control": "no-store" };

/** Request bodies are one short JSON object. */
const MAX_BODY_BYTES = 1_024;

/**
 * Runs a route under /api/admin/updates for a library admin with a session.
 * Everyone else gets 404, as on admin pages. POSTs must come from the
 * library's own origin: the session cookie is SameSite=Lax, and the Origin
 * header is checked as for uploads (src/app/api/uploads/route.ts).
 */
export async function handleUpdatesRoute(request: Request, run: (admin: PersonRow) => Promise<UpdatesResult>): Promise<Response> {
  const person = await getCurrentPerson();
  if (!person?.isAdmin) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
  if (request.method !== "GET" && request.headers.get("origin") !== new URL(getAuthConfig().LIBRARY_BASE_URL).origin) {
    return Response.json({ error: "This request came from another site." }, { status: 403, headers: NO_STORE });
  }
  const { httpStatus, body } = await run(person);
  return Response.json(body, { status: httpStatus, headers: NO_STORE });
}

/** The request's JSON body; undefined when it is missing, too large, or not JSON. */
export async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
  try {
    const text = await request.text();
    return text.length > MAX_BODY_BYTES ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}
