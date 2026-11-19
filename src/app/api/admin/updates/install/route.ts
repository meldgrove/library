import { z } from "zod";
import { logger } from "@/lib/logger";
import { handleUpdatesRoute, readJson } from "@/lib/updates/routes";
import { isInstallableVersion } from "@/lib/updates/types";
import { callUpdater, refuseWithStatus, updaterCalls } from "@/lib/updates/updater";

const bodySchema = z.object({ version: z.string().refine(isInstallableVersion) });

/** Installs an available version now (admins only); 202 when the updater accepted it. */
export function POST(request: Request): Promise<Response> {
  return handleUpdatesRoute(request, async (admin) => {
    const parsed = bodySchema.safeParse(await readJson(request));
    if (!parsed.success) return refuseWithStatus(400, "Name the version to install, such as 0.2.1.");
    logger.info({ personId: admin.id, version: parsed.data.version }, "update install requested");
    return callUpdater(updaterCalls.install(parsed.data.version));
  });
}
