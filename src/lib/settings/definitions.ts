import { z } from "zod";
import type { FieldErrors } from "@/lib/commands";
import { SLACK_CHANNEL_ID_PATTERN } from "@/lib/library/constants";
import { lastCharactersHint, urlHint, type SealedSecret } from "./secret-box";
import { otherSmtpOptions, SMTP_URL_OPTIONS } from "./smtp-url";

/*
 * The settings of Admin › Integrations: what each one holds, how a body
 * changes it, and what the page and `cli settings` show of it. The admin page
 * and the operator command both save through `service.ts`, which uses these
 * definitions; neither checks anything itself.
 *
 * A body is a JSON object with some of the setting's fields:
 *
 * - A secret (token, password, key): omitted or "" keeps the saved one, a
 *   string replaces it, null removes it. Secrets are never shown again.
 * - Other fields: omitted keeps the saved value, a value replaces it, null
 *   or "" clears it.
 */

/** In the order of the admin page. */
export const SETTING_NAMES = ["ai", "email", "slack", "digest", "webhook", "email-intake"] as const;
export type SettingName = (typeof SETTING_NAMES)[number];
export type SettingState = "set" | "not set" | "incomplete";

export const isSettingName = (value: unknown): value is SettingName => (SETTING_NAMES as readonly unknown[]).includes(value);

/** What the database keeps: plain fields, and sealed secrets. */
export type StoredFields = Record<string, string | string[] | SealedSecret | null>;

/** What the page and `show` get for a secret. */
export interface SecretView {
  saved: boolean;
  /** The last characters, or the scheme, host and port of a URL; null when nothing is saved. */
  hint: string | null;
}

type FieldSpec =
  | { kind: "secret"; label: string; schema: z.ZodType<string>; hint: (value: string) => string }
  | { kind: "text"; label: string; schema: z.ZodType<string> }
  | { kind: "choice"; label: string; options: readonly string[] }
  | { kind: "list"; label: string; item: z.ZodType<string> };

export type Change = { op: "set"; value: string | string[] } | { op: "clear" };

export interface SettingDefinition {
  name: SettingName;
  /** The card on Admin › Integrations. */
  title: string;
  /** One line for `cli help`. */
  label: string;
  fields: Record<string, FieldSpec>;
  /**
   * Rules across fields, after the body's changes are in `next`. May clear
   * secrets that are no longer used (`next` is the caller's copy).
   */
  finish(previous: StoredFields, next: StoredFields, changes: Map<string, Change>): FieldErrors;
  status(stored: StoredFields): { state: SettingState; hints: string[] };
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

const has = (value: unknown): boolean => (Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== "");
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const secretHint = (value: unknown): string | null => {
  // The webhook's URL as 0.3.3 and 0.3.4 saved it, until `sealWebhookUrl` ran.
  if (typeof value === "string") return urlHint(value);
  return value && typeof value === "object" && "hint" in value ? (value as SealedSecret).hint : null;
};

const httpUrl = z.url({ protocol: /^https?$/, error: "must be an http:// or https:// URL" });
/** A base URL that paths are appended to: without a trailing slash. */
const baseUrl = httpUrl.transform((url) => url.replace(/\/+$/, ""));
const email = z.email({ error: "must be an email address" }).transform((address) => address.toLowerCase());
const plainText = (max: number) => z.string().max(max, `must be at most ${max} characters`);
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** An imaps:// (or imap://) URL with user and password. */
const imapUrl = z.string().superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "must be an imaps:// (or imap://) URL with user and password" });
    return;
  }
  if (url.protocol !== "imaps:" && url.protocol !== "imap:") {
    context.addIssue({ code: "custom", message: "must be an imaps:// (or imap://) URL with user and password" });
  } else if (!url.username || !url.password) {
    context.addIssue({ code: "custom", message: "needs the user and password in the URL" });
  }
});

const smtpUrl = z.string().superRefine((value, context) => {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    // reported below
  }
  if (url?.protocol !== "smtp:" && url?.protocol !== "smtps:") {
    context.addIssue({ code: "custom", message: "must be an smtp:// or smtps:// URL" });
  } else if (otherSmtpOptions(value).length > 0) {
    context.addIssue({ code: "custom", message: `may only have these options after "?": ${SMTP_URL_OPTIONS.join(", ")}` });
  }
});

// ---------------------------------------------------------------------------
// The settings
// ---------------------------------------------------------------------------

const slack: SettingDefinition = {
  name: "slack",
  title: "Slack",
  label: "Slack: the bot token for messages, and the signing secret for the Slack bot",
  fields: {
    botToken: {
      kind: "secret",
      label: "Bot token",
      schema: z.string().startsWith("xoxb-", "must be a Slack bot token (xoxb-…)"),
      hint: lastCharactersHint,
    },
    signingSecret: {
      kind: "secret",
      label: "Signing secret",
      schema: z.string().regex(/^\S+$/, "must be the signing secret from the Slack app's Basic Information page"),
      hint: lastCharactersHint,
    },
  },
  // A signing secret alone is allowed; the Slack bot then cannot answer.
  finish: () => ({}),
  status(stored) {
    const hints = [
      has(stored.botToken) ? `bot token ${secretHint(stored.botToken)}` : "no bot token (the Slack bot cannot answer)",
      has(stored.signingSecret) ? `signing secret ${secretHint(stored.signingSecret)}` : "no signing secret (the Slack bot is off)",
    ];
    if (has(stored.botToken)) return { state: "set", hints };
    return has(stored.signingSecret) ? { state: "incomplete", hints } : { state: "not set", hints: [] };
  },
};

const EMAIL_SECRETS = { smtp: "smtpUrl", mailersend: "mailersendToken" } as const;

const emailSetting: SettingDefinition = {
  name: "email",
  title: "Email",
  label: "Email: SMTP or MailerSend, and the sender",
  fields: {
    provider: { kind: "choice", label: "Provider", options: ["smtp", "mailersend"] },
    smtpUrl: { kind: "secret", label: "SMTP URL", schema: smtpUrl, hint: urlHint },
    mailersendToken: { kind: "secret", label: "MailerSend API token", schema: z.string().regex(/^\S+$/, "must be a MailerSend API token"), hint: lastCharactersHint },
    from: { kind: "text", label: "Sender address", schema: email },
    fromName: { kind: "text", label: "Sender name", schema: plainText(100) },
  },
  finish(_previous, next, changes) {
    const errors: FieldErrors = {};
    const provider = text(next.provider) as keyof typeof EMAIL_SECRETS | null;
    for (const [name, field] of Object.entries(EMAIL_SECRETS)) {
      if (changes.get(field)?.op === "set" && provider !== name) errors.provider = `must be "${name}" to save the ${name === "smtp" ? "SMTP URL" : "MailerSend API token"}`;
      // Only the provider in use keeps its secret.
      if (provider !== name) next[field] = null;
    }
    if (provider) {
      if (!has(next[EMAIL_SECRETS[provider]])) errors[EMAIL_SECRETS[provider]] = `is required for ${provider === "smtp" ? "SMTP" : "MailerSend"}`;
      if (!has(next.from)) errors.from = "is required to send email";
    }
    return errors;
  },
  status(stored) {
    const provider = text(stored.provider) as keyof typeof EMAIL_SECRETS | null;
    if (!provider) return { state: "not set", hints: [] };
    const secret = stored[EMAIL_SECRETS[provider]];
    const hints = [
      provider === "smtp" ? `SMTP ${secretHint(secret) ?? "(no URL)"}` : `MailerSend token ${secretHint(secret) ?? "(none)"}`,
      has(stored.from) ? `from ${text(stored.fromName) ?? DEFAULT_FROM_NAME} <${text(stored.from)}>` : "no sender address",
    ];
    return { state: has(secret) && has(stored.from) ? "set" : "incomplete", hints };
  },
};

/** The sender name when the email setting has none. */
export const DEFAULT_FROM_NAME = "Meldgrove Library";

const digest: SettingDefinition = {
  name: "digest",
  title: "Weekly digest",
  label: "Weekly digest: the Slack channel and the email address for notes for everyone",
  fields: {
    slackChannelId: {
      kind: "text",
      label: "Slack channel ID",
      schema: z.string().regex(SLACK_CHANNEL_ID_PATTERN, "must be a Slack channel ID such as C0123456789"),
    },
    emailTo: { kind: "text", label: "Email address", schema: email },
  },
  finish: () => ({}),
  status(stored) {
    const hints = [
      ...(has(stored.slackChannelId) ? [`Slack channel ${text(stored.slackChannelId)}`] : []),
      ...(has(stored.emailTo) ? [`email ${text(stored.emailTo)}`] : []),
    ];
    return { state: hints.length > 0 ? "set" : "not set", hints };
  },
};

const webhook: SettingDefinition = {
  name: "webhook",
  title: "Webhook",
  label: "Webhook: the URL that gets published notes, and its signing secret",
  fields: {
    // A receiver may carry a token in its path or query.
    url: { kind: "secret", label: "URL", schema: httpUrl, hint: urlHint },
    secret: { kind: "secret", label: "Signing secret", schema: z.string().min(16, "must be at least 16 characters"), hint: lastCharactersHint },
  },
  finish(_previous, next): FieldErrors {
    // Off: the secret goes too.
    if (!has(next.url)) {
      next.secret = null;
      return {};
    }
    return has(next.secret) ? {} : { secret: "is required with a URL" };
  },
  status(stored) {
    if (!has(stored.url)) return { state: "not set", hints: [] };
    const hints = [secretHint(stored.url)!, has(stored.secret) ? `secret ${secretHint(stored.secret)}` : "no secret"];
    return { state: has(stored.secret) ? "set" : "incomplete", hints };
  },
};

export const AI_PROVIDERS = ["anthropic", "openai-compatible"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

const ai: SettingDefinition = {
  name: "ai",
  title: "AI model",
  label: "AI model: Anthropic or an OpenAI-compatible API, its key and model",
  fields: {
    provider: { kind: "choice", label: "Provider", options: AI_PROVIDERS },
    apiKey: { kind: "secret", label: "API key", schema: z.string().regex(/^\S+$/, "must be an API key without spaces"), hint: lastCharactersHint },
    model: { kind: "text", label: "Model", schema: z.string().regex(/^\S{1,200}$/, "must be a model name such as claude-opus-5-5") },
    baseUrl: { kind: "text", label: "Base URL", schema: baseUrl },
  },
  finish(previous, next, changes) {
    const errors: FieldErrors = {};
    const provider = text(next.provider);
    if (!provider) {
      // Off: the key goes too.
      next.apiKey = null;
      return errors;
    }
    // A key belongs to its provider.
    if (text(previous.provider) && text(previous.provider) !== provider && changes.get("apiKey")?.op !== "set") {
      errors.apiKey = "is required when the provider changes";
    } else if (!has(next.apiKey)) {
      errors.apiKey = "is required";
    }
    if (!has(next.model)) errors.model = "is required";
    if (provider === "openai-compatible" && !has(next.baseUrl)) errors.baseUrl = "is required for an OpenAI-compatible API, up to and including /v1";
    return errors;
  },
  status(stored) {
    const provider = text(stored.provider);
    if (!provider) return { state: "not set", hints: [] };
    const hints = [
      provider,
      has(stored.model) ? `model ${text(stored.model)}` : "no model",
      has(stored.apiKey) ? `key ${secretHint(stored.apiKey)}` : "no key",
      ...(provider === "openai-compatible" ? [has(stored.baseUrl) ? `base URL ${text(stored.baseUrl)}` : "no base URL"] : []),
    ];
    const complete = has(stored.apiKey) && has(stored.model) && (provider !== "openai-compatible" || has(stored.baseUrl));
    return { state: complete ? "set" : "incomplete", hints };
  },
};

/** The mailbox the intake reads when the setting names none. */
export const DEFAULT_INTAKE_MAILBOX = "INBOX";

const emailIntake: SettingDefinition = {
  name: "email-intake",
  title: "Email intake",
  label: "Email intake: the IMAP mailbox staff forward sources to, and their domains",
  fields: {
    imapUrl: { kind: "secret", label: "IMAP URL", schema: imapUrl, hint: urlHint },
    mailbox: { kind: "text", label: "Mailbox", schema: plainText(200) },
    domains: { kind: "list", label: "Sender domains", item: z.string().regex(DOMAIN, "must be domain names such as example.org") },
    doneMailbox: { kind: "text", label: "Done mailbox", schema: plainText(200) },
  },
  finish(_previous, next): FieldErrors {
    if (has(next.imapUrl) && !has(next.domains)) return { domains: "is required with an IMAP URL: list the domains staff send from" };
    return {};
  },
  status(stored) {
    if (!has(stored.imapUrl)) return { state: "not set", hints: [] };
    const domains = Array.isArray(stored.domains) ? stored.domains : [];
    const hints = [
      secretHint(stored.imapUrl)!,
      `mailbox ${text(stored.mailbox) ?? DEFAULT_INTAKE_MAILBOX}`,
      domains.length > 0 ? `domains ${domains.join(" ")}` : "no domains",
      ...(has(stored.doneMailbox) ? [`done mailbox ${text(stored.doneMailbox)}`] : []),
    ];
    return { state: domains.length > 0 ? "set" : "incomplete", hints };
  },
};

/** The settings in the order of the admin page. */
export const SETTINGS: Record<SettingName, SettingDefinition> = {
  ai,
  email: emailSetting,
  slack,
  digest,
  webhook,
  "email-intake": emailIntake,
};

export const SETTINGS_IN_ORDER: SettingDefinition[] = Object.values(SETTINGS);

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads a body into changes. Messages never repeat a value or an unknown
 * field's name: either could be a secret pasted in the wrong place.
 */
export function parseBody(definition: SettingDefinition, body: unknown): { changes: Map<string, Change>; errors: FieldErrors } {
  const changes = new Map<string, Change>();
  const errors: FieldErrors = {};
  if (!isPlainObject(body)) return { changes, errors: { form: "The body must be a JSON object." } };
  if (Object.keys(body).some((key) => !Object.hasOwn(definition.fields, key))) {
    errors.form = `The body has fields that the ${definition.name} setting does not have. Its fields are ${Object.keys(definition.fields).join(", ")}.`;
  }
  for (const [field, spec] of Object.entries(definition.fields)) {
    if (!Object.hasOwn(body, field)) continue;
    const raw = body[field];
    if (raw === undefined) continue;
    switch (spec.kind) {
      case "secret": {
        if (raw === null) changes.set(field, { op: "clear" });
        else if (typeof raw !== "string") errors[field] = "must be text, or null to remove it";
        else if (raw.trim() !== "") {
          const parsed = spec.schema.safeParse(raw.trim());
          if (parsed.success) changes.set(field, { op: "set", value: parsed.data });
          else errors[field] = parsed.error.issues[0]?.message ?? "is not valid";
        }
        break;
      }
      case "text": {
        if (raw === null || (typeof raw === "string" && raw.trim() === "")) changes.set(field, { op: "clear" });
        else if (typeof raw !== "string") errors[field] = "must be text";
        else {
          const parsed = spec.schema.safeParse(raw.trim());
          if (parsed.success) changes.set(field, { op: "set", value: parsed.data });
          else errors[field] = parsed.error.issues[0]?.message ?? "is not valid";
        }
        break;
      }
      case "choice": {
        if (raw === null || raw === "") changes.set(field, { op: "clear" });
        else if (typeof raw === "string" && spec.options.includes(raw)) changes.set(field, { op: "set", value: raw });
        else errors[field] = `must be one of ${spec.options.map((option) => `"${option}"`).join(", ")}, or null`;
        break;
      }
      case "list": {
        if (raw === null) changes.set(field, { op: "clear" });
        else if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) errors[field] = "must be a list of text";
        else {
          const items = [...new Set((raw as string[]).map((item) => item.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
          const invalid = items.map((item) => spec.item.safeParse(item)).find((parsed) => !parsed.success);
          if (invalid && !invalid.success) errors[field] = invalid.error.issues[0]?.message ?? "is not valid";
          else changes.set(field, items.length > 0 ? { op: "set", value: items } : { op: "clear" });
        }
        break;
      }
    }
  }
  return { changes, errors };
}

/** The setting as the page and `cli settings show` read it: values, and hints for secrets. */
export function viewOf(definition: SettingDefinition, stored: StoredFields): Record<string, unknown> {
  const view: Record<string, unknown> = { state: definition.status(stored).state };
  for (const [field, spec] of Object.entries(definition.fields)) {
    const value = stored[field] ?? null;
    if (spec.kind === "secret") view[field] = { saved: has(value), hint: secretHint(value) } satisfies SecretView;
    else if (spec.kind === "list") view[field] = Array.isArray(value) ? value : [];
    else view[field] = text(value);
  }
  return view;
}

/** The fields of the setting, empty. */
export function emptyFields(definition: SettingDefinition): StoredFields {
  return Object.fromEntries(Object.entries(definition.fields).map(([field, spec]) => [field, spec.kind === "list" ? [] : null]));
}

export const isSecretField = (definition: SettingDefinition, field: string) => definition.fields[field]?.kind === "secret";
