import { getDb } from "@/lib/db/client";
import { createSettingsReader, slackValues, type SettingsReader } from "./runtime";
import { getSettingsKey } from "./secret-box";

/*
 * The settings of this process (web): one reader, created at first use. The
 * worker builds its own in `src/workers/integrations.ts`.
 */

let reader: SettingsReader | undefined;

export function getSettingsReader(): SettingsReader {
  reader ??= createSettingsReader(getDb(), getSettingsKey());
  return reader;
}

/** The Slack app's signing secret, or null while the Slack bot is off. Read on each request. */
export async function readSlackSigningSecret(): Promise<string | null> {
  return slackValues(await getSettingsReader().read("slack")).signingSecret;
}
