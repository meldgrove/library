import { handleUpdatesRoute } from "@/lib/updates/routes";
import { callUpdater, updaterCalls } from "@/lib/updates/updater";

/** Checks for updates now (admins only). */
export function POST(request: Request): Promise<Response> {
  return handleUpdatesRoute(request, () => callUpdater(updaterCalls.check()));
}
