import type { Database } from "@/lib/db/client";
import { logger } from "@/lib/logger";
import { DEFAULT_FROM_NAME, DEFAULT_INTAKE_MAILBOX, type AiProvider, type SettingName } from "./definitions";
import { legacyValues } from "./legacy-env";
import { loadSettingValues, type SettingValues } from "./service";

/*
 * How a running process reads the settings: from the database on each use
 * (a save on the admin page or with `cli settings` applies at the next
 * use), or, in a process without BETTER_AUTH_SECRET, from the old variables
 * (`legacy-env.ts`).
 */

type Env = Record<string, string | undefined>;

export type SettingsMode = "database" | "environment";

export interface SettingsReader {
  mode: SettingsMode;
  read(name: SettingName): Promise<SettingValues>;
}

export function createSettingsReader(db: Database, key: Buffer | null, env: Env = process.env): SettingsReader {
  if (!key) {
    // The variables do not change while the process runs.
    const cache = new Map<SettingName, SettingValues>();
    return {
      mode: "environment",
      read: async (name) => {
        if (!cache.has(name)) cache.set(name, legacyValues(name, env));
        return cache.get(name)!;
      },
    };
  }
  const warned = new Set<string>();
  return {
    mode: "database",
    async read(name) {
      const values = await loadSettingValues(db, key, name);
      for (const field of values.unreadable) {
        if (warned.has(`${name}.${field}`)) continue;
        warned.add(`${name}.${field}`);
        logger.error({ setting: name, field }, "a saved secret cannot be read (BETTER_AUTH_SECRET changed): enter it again under Admin › Integrations");
      }
      return values;
    },
  };
}

const str = (value: string | string[] | null | undefined): string | null => (typeof value === "string" && value ? value : null);

export interface SlackValues {
  botToken: string | null;
  signingSecret: string | null;
}

export const slackValues = ({ values }: SettingValues): SlackValues => ({ botToken: str(values.botToken), signingSecret: str(values.signingSecret) });

export type EmailValues =
  | { provider: "smtp"; smtpUrl: string; from: string; fromName: string }
  | { provider: "mailersend"; token: string; from: string; fromName: string };

/** The email transport's settings, or null while email is off or incomplete. */
export function emailValues({ state, values }: SettingValues): EmailValues | null {
  if (state !== "set") return null;
  const from = str(values.from)!;
  const fromName = str(values.fromName) ?? DEFAULT_FROM_NAME;
  if (values.provider === "smtp") return { provider: "smtp", smtpUrl: str(values.smtpUrl)!, from, fromName };
  if (values.provider === "mailersend") return { provider: "mailersend", token: str(values.mailersendToken)!, from, fromName };
  return null;
}

/** Which channels are set up, but have a saved secret that cannot be read; for email, which one. */
export interface UnreadableChannels {
  slack: boolean;
  email: string | null;
}

export function unreadableChannels(slack: SettingValues, email: SettingValues): UnreadableChannels {
  const { provider } = email.values;
  const secret = provider === "smtp" ? "smtpUrl" : provider === "mailersend" ? "mailersendToken" : null;
  return {
    slack: slack.unreadable.includes("botToken"),
    email: secret && str(email.values.from) && email.unreadable.includes(secret) ? (secret === "smtpUrl" ? "The SMTP URL" : "The MailerSend API token") : null,
  };
}

export interface DigestValues {
  slackChannelId?: string;
  emailTo?: string;
}

export const digestValues = ({ values }: SettingValues): DigestValues => ({
  slackChannelId: str(values.slackChannelId) ?? undefined,
  emailTo: str(values.emailTo) ?? undefined,
});

export const webhookValues = ({ state, values }: SettingValues): { url: string; secret: string } | null =>
  state === "set" ? { url: str(values.url)!, secret: str(values.secret)! } : null;

export interface AiValues {
  provider: AiProvider;
  apiKey: string;
  model: string;
  baseUrl: string | null;
}

export function aiValues({ state, values }: SettingValues): AiValues | null {
  if (state !== "set") return null;
  return { provider: values.provider as AiProvider, apiKey: str(values.apiKey)!, model: str(values.model)!, baseUrl: str(values.baseUrl) };
}

export interface EmailIntakeValues {
  imapUrl: string;
  mailbox: string;
  domains: string[];
  doneMailbox?: string;
}

export function emailIntakeValues({ state, values }: SettingValues): EmailIntakeValues | null {
  if (state !== "set") return null;
  return {
    imapUrl: str(values.imapUrl)!,
    mailbox: str(values.mailbox) ?? DEFAULT_INTAKE_MAILBOX,
    domains: Array.isArray(values.domains) ? values.domains : [],
    doneMailbox: str(values.doneMailbox) ?? undefined,
  };
}

/** The same values give the same string: a client is built again only when its settings change. */
export function memoize<V, T>(build: (values: V) => T): (values: V) => T {
  let lastKey: string | undefined;
  let last: T;
  return (values) => {
    const key = JSON.stringify(values);
    if (key !== lastKey) {
      last = build(values);
      lastKey = key;
    }
    return last;
  };
}
