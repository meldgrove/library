import { handleUpdatesRoute } from "@/lib/updates/routes";
import { callUpdater, updaterCalls } from "@/lib/updates/updater";

// The update status for the update button and the admin page (admins only).
// It never checks for updates by itself: that takes POST …/check.
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleUpdatesRoute(request, () => callUpdater(updaterCalls.status()));
}
