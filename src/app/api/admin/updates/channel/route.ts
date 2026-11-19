import { z } from "zod";
import { logger } from "@/lib/logger";
import { handleUpdatesRoute, readJson } from "@/lib/updates/routes";
import { CHANNELS } from "@/lib/updates/types";
import { callUpdater, refuseWithStatus, updaterCalls } from "@/lib/updates/updater";

const bodySchema = z.object({ channel: z.enum(CHANNELS) });

/** Switches between Stable and Preview (admins only); the updater checks right after. */
export function POST(request: Request): Promise<Response> {
  return handleUpdatesRoute(request, async (admin) => {
    const parsed = bodySchema.safeParse(await readJson(request));
    if (!parsed.success) return refuseWithStatus(400, "The channel is stable or preview.");
    logger.info({ personId: admin.id, channel: parsed.data.channel }, "update channel change requested");
    return callUpdater(updaterCalls.channel(parsed.data.channel));
  });
}
