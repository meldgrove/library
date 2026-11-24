import { handleUpdatesRoute } from "@/lib/updates/routes";

/** Checks for updates now (admins only). */
export function POST(request: Request): Promise<Response> {
  return handleUpdatesRoute("check", request);
}
