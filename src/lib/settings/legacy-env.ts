import { desc, like, sql } from "drizzle-orm";
import { CommandError } from "@/lib/commands";
import type { Database } from "@/lib/db/client";
import { appSetting, workerHeartbeat } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { NotificationChannels } from "@/lib/notifications/types";
import { environment } from "./actor";
import { emptyFields, parseBody, SETTINGS, SETTINGS_IN_ORDER, type SettingName, type StoredFields } from "./definitions";
import { applySetting, readStored, type SettingValues } from "./service";

/*
 * The variables that held these settings up to 0.3.2. A process that sees one
 * copies it into the database once, when the database has no value for its
 * field yet; afterwards the database wins and the variable is ignored. The
 * admin page, `cli settings list` and one warning at start name the
 * variables that are still set, so the operator can delete them.
 *
 * A worker started with a Compose file up to 0.3.2 has no BETTER_AUTH_SECRET,
 * so it can neither seal nor open the stored secrets: it keeps reading these
 * variables, as before ("environment mode"), until compose.yaml is updated.
 */

type Env = Record<string, string | undefined>;

/** Old variable → field, per setting. */
export const LEGACY_VARIABLES: Record<SettingName, Record<string, string>> = {
  slack: { SLACK_BOT_TOKEN: "botToken", SLACK_SIGNING_SECRET: "signingSecret" },
  email: { SMTP_URL: "smtpUrl", MAILERSEND_API_TOKEN: "mailersendToken", MAIL_FROM: "from", MAIL_FROM_NAME: "fromName" },
  digest: { DIGEST_SLACK_CHANNEL_ID: "slackChannelId", DIGEST_EMAIL_TO: "emailTo" },
  webhook: { WEBHOOK_URL: "url", WEBHOOK_SECRET: "secret" },
  ai: { AI_PROVIDER: "provider", AI_API_KEY: "apiKey", AI_MODEL: "model", AI_BASE_URL: "baseUrl" },
  "email-intake": {
    EMAIL_INTAKE_IMAP_URL: "imapUrl",
    EMAIL_INTAKE_MAILBOX: "mailbox",
    EMAIL_INTAKE_DOMAINS: "domains",
    EMAIL_INTAKE_DONE_MAILBOX: "doneMailbox",
  },
};

export const ALL_LEGACY_VARIABLES = Object.values(LEGACY_VARIABLES).flatMap((variables) => Object.keys(variables));

const value = (env: Env, name: string) => {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
};

/**
 * The old variables set in `env`, by setting. Not counted: AI_PROVIDER=fake
 * (the development switch, which stays) and an AI_PROVIDER without
 * AI_API_KEY (the default of compose.yaml up to 0.3.2).
 */
export function presentVariables(env: Env): Partial<Record<SettingName, string[]>> {
  const present: Partial<Record<SettingName, string[]>> = {};
  for (const [name, variables] of Object.entries(LEGACY_VARIABLES) as [SettingName, Record<string, string>][]) {
    const set = Object.keys(variables).filter((variable) => {
      if (!value(env, variable)) return false;
      if (variable === "AI_PROVIDER") return value(env, variable) !== "fake" && Boolean(value(env, "AI_API_KEY"));
      return true;
    });
    if (set.length > 0) present[name] = set;
  }
  return present;
}

/** The body the admin page would send for these variables. */
function bodyFrom(name: SettingName, env: Env, variables: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const variable of variables) {
    const field = LEGACY_VARIABLES[name][variable]!;
    const raw = value(env, variable)!;
    body[field] = field === "domains" ? raw.split(/[\s,;]+/).filter(Boolean) : raw;
  }
  // The old variables named the email provider by which one was set.
  if (name === "email" && !("provider" in body)) {
    if ("smtpUrl" in body) body.provider = "smtp";
    else if ("mailersendToken" in body) body.provider = "mailersend";
  }
  // compose.yaml up to 0.3.2 set AI_PROVIDER=openai-compatible when it was not in .env.
  if (name === "ai" && !("provider" in body) && "apiKey" in body) body.provider = "openai-compatible";
  return body;
}

/**
 * The settings from the old variables, for a process without
 * BETTER_AUTH_SECRET. Invalid values make the setting off, with a warning
 * that names the fields, never the values.
 */
export function legacyValues(name: SettingName, env: Env): SettingValues {
  const definition = SETTINGS[name];
  const variables = presentVariables(env)[name] ?? [];
  const empty = { state: "not set" as const, values: { ...emptyFields(definition) } as SettingValues["values"], unreadable: [] };
  if (variables.length === 0) return empty;
  const { changes, errors } = parseBody(definition, bodyFrom(name, env, variables));
  const stored: StoredFields = emptyFields(definition);
  const values: SettingValues["values"] = { ...empty.values };
  for (const [field, change] of changes) {
    if (change.op === "clear") continue;
    values[field] = change.value;
    const spec = definition.fields[field]!;
    stored[field] = spec.kind === "secret" ? { sealed: "", hint: spec.hint(change.value as string) } : change.value;
  }
  const finishErrors = definition.finish(emptyFields(definition), stored, changes);
  const problems = { ...errors, ...finishErrors };
  if (Object.keys(problems).length > 0) {
    logger.warn({ setting: name, fields: Object.keys(problems) }, "the old variables of this setting are not valid; it stays off");
    return empty;
  }
  for (const [field, stillSet] of Object.entries(stored)) if (stillSet === null) values[field] = null;
  return { state: definition.status(stored).state, values, unreadable: [] };
}

const LEDGER_KEY = "settings.imported";
const leftoverKey = (process: string) => `settings.leftovers.${process}`;

export interface ImportResult {
  imported: { setting: SettingName; variables: string[] }[];
  /** Variables not imported because the setting refused them; tried again at the next start. */
  refused: { setting: SettingName; variables: string[]; message: string }[];
}

/**
 * Copies old variables into the database, each once, and only into empty
 * fields. Processes that start together take turns (an advisory lock), so a
 * variable is imported once. Writes an audit entry per setting with the
 * actor `environment`.
 */
export async function importLegacySettings(db: Database, key: Buffer, env: Env, processName: string, now: Date = new Date()): Promise<ImportResult> {
  const present = presentVariables(env);
  const result: ImportResult = { imported: [], refused: [] };
  if (Object.keys(present).length === 0) return result;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('library.settings.import'))`);
    const [ledgerRow] = await tx.select({ value: appSetting.value }).from(appSetting).where(sql`${appSetting.key} = ${LEDGER_KEY}`);
    const ledger = { ...((ledgerRow?.value as Record<string, string> | undefined) ?? {}) };
    for (const definition of SETTINGS_IN_ORDER) {
      const pending = (present[definition.name] ?? []).filter((variable) => !ledger[variable]);
      if (pending.length === 0) continue;
      const stored = await readStored(tx, definition.name);
      const empty = (field: string) => {
        const current = stored[field];
        return current === null || current === undefined || (Array.isArray(current) && current.length === 0);
      };
      // The database wins: only fields without a value take the variable.
      const toImport = pending.filter((variable) => empty(LEGACY_VARIABLES[definition.name][variable]!));
      const body = bodyFrom(definition.name, env, toImport);
      if ((definition.name === "email" || definition.name === "ai") && !empty("provider")) delete body.provider;
      if (Object.keys(body).length > 0) {
        try {
          await tx.transaction((savepoint) =>
            applySetting(savepoint, key, definition.name, body, environment(processName), { variables: toImport }),
          );
          result.imported.push({ setting: definition.name, variables: toImport });
        } catch (error) {
          if (!(error instanceof CommandError)) throw error;
          result.refused.push({ setting: definition.name, variables: toImport, message: [error.message, ...Object.entries(error.fieldErrors).map(([field, message]) => `${field} ${message}`)].join(" ") });
          continue;
        }
      }
      for (const variable of pending) ledger[variable] = now.toISOString();
    }
    await tx
      .insert(appSetting)
      .values({ key: LEDGER_KEY, value: ledger })
      .onConflictDoUpdate({ target: appSetting.key, set: { value: ledger, updatedAt: now } });
  });
  return result;
}

/** Records which old variables this process still has (names only), for the admin page and `cli settings list`. */
export async function reportLeftovers(db: Database, processName: string, env: Env, now: Date = new Date()): Promise<string[]> {
  const variables = Object.values(presentVariables(env)).flat();
  await db
    .insert(appSetting)
    .values({ key: leftoverKey(processName), value: { variables, reportedAt: now.toISOString() } })
    .onConflictDoUpdate({ target: appSetting.key, set: { value: { variables, reportedAt: now.toISOString() }, updatedAt: now } });
  return variables;
}

/** The old variables each process reported at its last start, plus this process's own. */
export async function leftoverVariables(db: Database, own?: { process: string; env: Env }): Promise<{ variable: string; processes: string[] }[]> {
  const rows = await db.select({ key: appSetting.key, value: appSetting.value }).from(appSetting).where(like(appSetting.key, "settings.leftovers.%"));
  const byVariable = new Map<string, Set<string>>();
  const add = (variable: string, process: string) => byVariable.set(variable, (byVariable.get(variable) ?? new Set()).add(process));
  for (const row of rows) {
    const process = row.key.slice("settings.leftovers.".length);
    if (own && process === own.process) continue;
    for (const variable of (row.value as { variables?: string[] }).variables ?? []) add(variable, process);
  }
  if (own) for (const variable of Object.values(presentVariables(own.env)).flat()) add(variable, own.process);
  return ALL_LEGACY_VARIABLES.filter((variable) => byVariable.has(variable)).map((variable) => ({ variable, processes: [...byVariable.get(variable)!].sort() }));
}

/**
 * At start: imports what can be imported, records the leftovers, and logs
 * one warning without values. Without a key (a worker started with a Compose
 * file up to 0.3.2), only records and warns.
 */
export async function importAtStart(db: Database, key: Buffer | null, processName: string, env: Env = process.env): Promise<void> {
  if (key) {
    const result = await importLegacySettings(db, key, env, processName);
    for (const imported of result.imported) logger.info({ setting: imported.setting, variables: imported.variables }, "old variables copied into the database");
    for (const refused of result.refused) logger.warn({ setting: refused.setting, variables: refused.variables, reason: refused.message }, "old variables not copied into the database");
  }
  const leftovers = await reportLeftovers(db, processName, env);
  if (leftovers.length === 0) return;
  if (key) {
    logger.warn({ variables: leftovers }, "these variables are no longer read: the settings are in the database (Admin › Integrations). Delete them from .env");
  } else {
    logger.warn(
      { variables: leftovers },
      "this process has no BETTER_AUTH_SECRET, so it reads these variables instead of the settings in the database. Update compose.yaml (docs/deployment.md, Upgrades)",
    );
  }
}

/**
 * Where the newest worker reads its settings: "environment" means it has no
 * BETTER_AUTH_SECRET (a Compose file up to 0.3.2) and ignores the settings in
 * the database. Null until a worker has reported.
 */
export async function workerSettingsMode(db: Database): Promise<"database" | "environment" | null> {
  return (await latestWorkerChannels(db))?.settings ?? null;
}

/** What the newest worker reported about its channels and the AI model; null until one has reported. */
export async function latestWorkerChannels(db: Database): Promise<NotificationChannels | null> {
  const [row] = await db.select({ channels: workerHeartbeat.channels }).from(workerHeartbeat).orderBy(desc(workerHeartbeat.beatAt)).limit(1);
  return row?.channels ?? null;
}
