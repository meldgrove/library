import { handleUpdatesRoute } from "@/lib/updates/routes";

/** Installs an available version now (admins only); 202 when the updater accepted it. */
export function POST(request: Request): Promise<Response> {
  return handleUpdatesRoute("install", request);
}
