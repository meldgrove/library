import { eq, like } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { CommandError, type FieldErrors } from "@/lib/commands";
import type { Database, Transaction } from "@/lib/db/client";
import { appSetting } from "@/lib/db/schema";
import { isEnvironment, isOperator, type SettingsActor } from "./actor";
import {
  emptyFields,
  parseBody,
  SETTINGS,
  SETTINGS_IN_ORDER,
  viewOf,
  type SettingDefinition,
  type SettingName,
  type SettingState,
  type StoredFields,
} from "./definitions";
import { openSecret, sealSecret, SecretError, type SealedSecret } from "./secret-box";

/*
 * The one place that reads and saves the settings of Admin › Integrations.
 * The admin page's Server Actions, the operator command (`cli settings`) and
 * the import of old variables all call `applySetting`; the worker and the
 * web process read with `loadSettingValues` each time they use a setting, so
 * a save reaches them without a restart or a signal.
 */

const rowKey = (name: SettingName) => `integration.${name}`;

/** The setting as stored, with every field (empty ones as null or []). */
export async function readStored(db: Database | Transaction, name: SettingName): Promise<StoredFields> {
  const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, rowKey(name)));
  return { ...emptyFields(SETTINGS[name]), ...((row?.value as StoredFields | undefined) ?? {}) };
}

/** Every stored setting at once (the admin page and `cli settings list`). */
export async function readAllStored(db: Database): Promise<Record<SettingName, StoredFields>> {
  const rows = await db.select({ key: appSetting.key, value: appSetting.value }).from(appSetting).where(like(appSetting.key, "integration.%"));
  const byKey = new Map(rows.map((row) => [row.key, row.value as StoredFields]));
  return Object.fromEntries(
    SETTINGS_IN_ORDER.map((definition) => [definition.name, { ...emptyFields(definition), ...(byKey.get(rowKey(definition.name)) ?? {}) }]),
  ) as Record<SettingName, StoredFields>;
}

const isSealed = (value: unknown): value is SealedSecret => typeof value === "object" && value !== null && "sealed" in value;

/** The secret fields whose saved value this key cannot open (BETTER_AUTH_SECRET changed). */
function unreadableSecrets(definition: SettingDefinition, stored: StoredFields, key: Buffer): string[] {
  return Object.entries(definition.fields).flatMap(([field, spec]) => {
    const value = stored[field];
    if (spec.kind !== "secret" || !isSealed(value)) return [];
    try {
      openSecret(key, `${definition.name}.${field}`, value.sealed);
      return [];
    } catch {
      return [field];
    }
  });
}

export interface SettingStatus {
  name: SettingName;
  title: string;
  state: SettingState;
  /** What the page shows at a glance: addresses, `key …a1b2`. Never a secret. */
  hints: string[];
}

/** State and hints. With a key, a secret it cannot open makes the setting incomplete. */
export function statusOf(definition: SettingDefinition, stored: StoredFields, key: Buffer | null): SettingStatus {
  const status = definition.status(stored);
  const unreadable = key ? unreadableSecrets(definition, stored, key) : [];
  if (unreadable.length === 0) return { name: definition.name, title: definition.title, ...status };
  return {
    name: definition.name,
    title: definition.title,
    state: "incomplete",
    hints: [...status.hints, `${unreadable.join(", ")} cannot be read (BETTER_AUTH_SECRET changed): enter ${unreadable.length === 1 ? "it" : "them"} again`],
  };
}

/** What the admin page and `cli settings show` read: values, and hints for secrets. */
export async function showSetting(db: Database, name: SettingName, key: Buffer | null): Promise<Record<string, unknown>> {
  const definition = SETTINGS[name];
  const stored = await readStored(db, name);
  return { ...viewOf(definition, stored), state: statusOf(definition, stored, key).state };
}

export async function listSettings(db: Database, key: Buffer | null): Promise<SettingStatus[]> {
  const stored = await readAllStored(db);
  return SETTINGS_IN_ORDER.map((definition) => statusOf(definition, stored[definition.name], key));
}

/** A setting with its secrets opened, for the process that uses it. A secret that cannot be opened counts as missing. */
export interface SettingValues {
  state: SettingState;
  values: Record<string, string | string[] | null>;
  /** Secret fields this process could not open. */
  unreadable: string[];
}

export function openStored(definition: SettingDefinition, stored: StoredFields, key: Buffer): SettingValues {
  const values: Record<string, string | string[] | null> = {};
  const unreadable: string[] = [];
  const readable: StoredFields = { ...stored };
  for (const [field, spec] of Object.entries(definition.fields)) {
    const value = stored[field] ?? null;
    if (spec.kind !== "secret") {
      values[field] = value as string | string[] | null;
      continue;
    }
    values[field] = null;
    if (!isSealed(value)) continue;
    try {
      values[field] = openSecret(key, `${definition.name}.${field}`, value.sealed);
    } catch (error) {
      if (!(error instanceof SecretError)) throw error;
      unreadable.push(field);
      readable[field] = null;
    }
  }
  return { state: definition.status(readable).state, values, unreadable };
}

export async function loadSettingValues(db: Database | Transaction, key: Buffer, name: SettingName): Promise<SettingValues> {
  return openStored(SETTINGS[name], await readStored(db, name), key);
}

/** A refused save: the field errors, and a message for the form (or the command's stderr). */
function refused(definition: SettingDefinition, errors: FieldErrors): CommandError {
  const { form, ...fields } = errors;
  const message = form ?? `The ${definition.title.toLowerCase()} setting was not saved. Check ${Object.keys(fields).join(", ")}.`;
  return new CommandError("invalid", message, fields);
}

/** Who saved, for the audit log and `updated_by_id`. */
function auditActor(actor: SettingsActor) {
  if (isOperator(actor)) return { actorId: null, payload: { actor: "operator", command: actor.command } };
  if (isEnvironment(actor)) return { actorId: null, payload: { actor: "environment", process: actor.process } };
  return { actorId: actor.personId, payload: {} };
}

export interface ApplyOptions {
  /** For the import: the old variables a save came from (audit only). */
  variables?: string[];
}

/**
 * Saves a body (the JSON the admin page sends) to a setting, with the page's
 * checks, sealing new secrets. Throws CommandError with the page's messages
 * when it refuses. Returns what `showSetting` returns.
 */
export async function applySetting(
  db: Database | Transaction,
  key: Buffer | null,
  name: SettingName,
  body: unknown,
  actor: SettingsActor,
  options: ApplyOptions = {},
): Promise<Record<string, unknown>> {
  const definition = SETTINGS[name];
  const { changes, errors } = parseBody(definition, body);
  if (Object.keys(errors).length > 0) throw refused(definition, errors);
  if (!key) {
    throw new CommandError("invalid", "This process has no BETTER_AUTH_SECRET, so it cannot save settings. Run the command in the migrate service of this release's compose.yaml.");
  }

  return db.transaction(async (tx) => {
    // One save at a time per setting: the row is locked from read to write.
    await tx.insert(appSetting).values({ key: rowKey(name), value: {} }).onConflictDoNothing();
    const [row] = await tx.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, rowKey(name))).for("update");
    const previous: StoredFields = { ...emptyFields(definition), ...((row?.value as StoredFields | undefined) ?? {}) };
    const next: StoredFields = { ...previous };
    for (const [field, change] of changes) {
      const spec = definition.fields[field]!;
      if (change.op === "clear") next[field] = spec.kind === "list" ? [] : null;
      else if (spec.kind === "secret") {
        const value = change.value as string;
        next[field] = { sealed: sealSecret(key, `${name}.${field}`, value), hint: spec.hint(value) };
      } else next[field] = change.value;
    }
    const crossErrors = definition.finish(previous, next, changes);
    if (Object.keys(crossErrors).length > 0) throw refused(definition, crossErrors);

    const changed = Object.keys(definition.fields).filter((field) => JSON.stringify(previous[field] ?? null) !== JSON.stringify(next[field] ?? null));
    const who = auditActor(actor);
    await tx
      .update(appSetting)
      .set({ value: next, updatedById: who.actorId, updatedAt: new Date() })
      .where(eq(appSetting.key, rowKey(name)));
    await recordAudit(tx, {
      actorId: who.actorId,
      action: isEnvironment(actor) ? "setting.imported" : "setting.changed",
      subjectType: "setting",
      payload: { setting: name, fields: changed, ...(options.variables ? { variables: options.variables } : {}), ...who.payload },
    });
    return { ...viewOf(definition, next), state: statusOf(definition, next, key).state };
  });
}
