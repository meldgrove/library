import { handleUpdatesRoute } from "@/lib/updates/routes";

/** Switches between Stable and Preview (admins only); the updater checks right after. */
export function POST(request: Request): Promise<Response> {
  return handleUpdatesRoute("channel", request);
}
