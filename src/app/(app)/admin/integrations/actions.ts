"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/session";
import { CommandError, type FieldErrors } from "@/lib/commands";
import { getDb } from "@/lib/db/client";
import { actorOf } from "@/lib/form-actions";
import { consumeRateLimit, RateLimitError, WRITE_LIMIT } from "@/lib/rate-limit";
import { isSettingName, SETTINGS } from "@/lib/settings/definitions";
import { getSettingsKey } from "@/lib/settings/secret-box";
import { applySetting } from "@/lib/settings/service";
import { isTestable, testSetting } from "@/lib/settings/tests";

/*
 * Admin › Integrations. The body is the one `cli settings apply` reads from
 * stdin; both save with `applySetting`, which checks it. The arguments come
 * from the browser as sent, so the name is checked too.
 */

export interface SettingActionResult {
  ok: boolean;
  message?: string;
  fieldErrors?: FieldErrors;
  /** After a save: what the page shows now (hints for secrets). */
  view?: Record<string, unknown>;
}

const OUT_OF_DATE: SettingActionResult = { ok: false, message: "This form is out of date. Reload the page and try again." };

export async function saveSettingAction(name: unknown, body: unknown): Promise<SettingActionResult> {
  const user = await requireAdmin();
  if (!isSettingName(name)) return OUT_OF_DATE;
  try {
    await consumeRateLimit(getDb(), `write:${user.person.id}`, WRITE_LIMIT);
    const view = await applySetting(getDb(), getSettingsKey(), name, body, actorOf(user));
    revalidatePath("/admin/integrations");
    revalidatePath("/admin");
    return { ok: true, message: `${SETTINGS[name].title} saved.`, view };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, message: error.message, fieldErrors: error.fieldErrors };
    if (error instanceof RateLimitError) return { ok: false, message: error.message };
    throw error;
  }
}

export async function testSettingAction(name: unknown, options: unknown): Promise<SettingActionResult> {
  const user = await requireAdmin();
  if (!isSettingName(name) || !isTestable(name)) return OUT_OF_DATE;
  const key = getSettingsKey();
  if (!key) return { ok: false, message: "The web process has no BETTER_AUTH_SECRET." };
  const to = typeof options === "object" && options !== null && typeof (options as { to?: unknown }).to === "string" ? (options as { to: string }).to : undefined;
  try {
    // A test reaches an outside service: it counts like a save.
    await consumeRateLimit(getDb(), `write:${user.person.id}`, WRITE_LIMIT);
    return await testSetting(getDb(), key, name, { to });
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, message: error.message, fieldErrors: error.fieldErrors };
    if (error instanceof RateLimitError) return { ok: false, message: error.message };
    throw error;
  }
}
