import { createUpdatesHandler, type UpdatesAction } from "@meldgrove/ui/updates/server";
import { canAdminister } from "@/lib/auth/roles";
import { getCurrentPerson } from "@/lib/auth/session";
import { getAuthConfig, getUpdaterConfig, getVersionConfig } from "@/lib/config";
import { logger } from "@/lib/logger";

/*
 * The routes under /api/admin/updates, which the update button and the
 * Updates card call. `@meldgrove/ui/updates/server` asks the Meldgrove Updater
 * (the `updater` service of compose.yaml), with UPDATER_TOKEN when it is set,
 * and answers as every Meldgrove app does. The library only decides who may ask.
 */

const NO_STORE = { "Cache-Control": "no-store" };

/** Request bodies are one short JSON object. */
const MAX_BODY_BYTES = 1_024;

const updates = createUpdatesHandler(() => ({
  url: getUpdaterConfig().UPDATER_URL,
  token: getUpdaterConfig().UPDATER_TOKEN,
  appVersion: getVersionConfig().APP_VERSION ?? null,
  logger,
}));

/**
 * Answers a route under /api/admin/updates for a library admin with a
 * session. Everyone else gets 404, as on admin pages, and the updater is not
 * asked. POSTs must come from the library's own origin: the session cookie is
 * SameSite=Lax, and the Origin header is checked as for uploads
 * (src/app/api/uploads/route.ts).
 */
export async function handleUpdatesRoute(action: UpdatesAction, request: Request): Promise<Response> {
  const person = await getCurrentPerson();
  if (!person || !canAdminister(person.role)) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
  if (request.method !== "GET" && request.headers.get("origin") !== new URL(getAuthConfig().LIBRARY_BASE_URL).origin) {
    return Response.json({ error: "This request came from another site." }, { status: 403, headers: NO_STORE });
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return Response.json({ error: "The request is too large." }, { status: 413, headers: NO_STORE });
  }
  if (action === "status") return updates.respond(action);
  const response = await updates.respond(action, request);
  // The updater logs the version or channel; this says which admin asked.
  logger.info({ personId: person.id, action, status: response.status }, "update action requested");
  return response;
}
