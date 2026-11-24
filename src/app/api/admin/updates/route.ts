import { handleUpdatesRoute } from "@/lib/updates/routes";

// The update status for the update button and the admin page (admins only).
// It never checks for updates by itself: that takes POST …/check.
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleUpdatesRoute("status", request);
}
