import type { AiLimitsConfig, NotificationConfig } from "@/lib/config";
import { draftModelFromSettings, type DraftModel } from "@/lib/library/draft";
import { createTransports, type Transports } from "@/lib/notifications/transports";
import type { NotificationChannels } from "@/lib/notifications/types";
import {
  aiValues,
  digestValues,
  emailIntakeValues,
  emailValues,
  memoize,
  slackValues,
  webhookValues,
  type AiValues,
  type DigestValues,
  type EmailIntakeValues,
  type SettingsReader,
} from "@/lib/settings/runtime";
import { createSlackIntakeClient, type SlackIntakeClient } from "@/lib/slack/client";
import { createWebhookClient, type WebhookClient } from "@/lib/webhook/client";

/*
 * What the worker builds from the settings, read again at each use: a save
 * on the admin page or with `cli settings` applies to the next message,
 * draft, webhook run, or intake run. A client is built again only when its
 * settings changed.
 */

export interface WorkerIntegrations {
  mode: SettingsReader["mode"];
  transports(): Promise<Transports>;
  /** Null while no AI provider is set up: drafting waits. */
  draftModel(): Promise<DraftModel | null>;
  webhookClient(): Promise<WebhookClient | null>;
  slackIntakeClient(): Promise<SlackIntakeClient | null>;
  emailIntake(): Promise<EmailIntakeValues | null>;
  digest(): Promise<DigestValues>;
  /** What the admin page shows for each channel. */
  channels(): Promise<NotificationChannels>;
}

export function createWorkerIntegrations(reader: SettingsReader, notification: NotificationConfig, limits: AiLimitsConfig): WorkerIntegrations {
  const transportsFor = memoize((values: { slackToken: string | null; email: ReturnType<typeof emailValues> }) =>
    createTransports({ mode: notification.NOTIFICATION_TRANSPORT, baseUrl: notification.LIBRARY_BASE_URL, ...values }),
  );
  const modelFor = memoize((ai: AiValues | null): DraftModel | null => draftModelFromSettings(ai, limits));
  const webhookFor = memoize((webhook: { url: string; secret: string } | null) => (webhook ? createWebhookClient(webhook) : null));
  const slackIntakeFor = memoize((token: string | null) => (token ? createSlackIntakeClient(token) : null));

  const transports = async () =>
    transportsFor({ slackToken: slackValues(await reader.read("slack")).botToken, email: emailValues(await reader.read("email")) });

  return {
    mode: reader.mode,
    transports,
    draftModel: async () => modelFor(limits.AI_FAKE ? null : aiValues(await reader.read("ai"))),
    webhookClient: async () => webhookFor(webhookValues(await reader.read("webhook"))),
    slackIntakeClient: async () => slackIntakeFor(slackValues(await reader.read("slack")).botToken),
    emailIntake: async () => emailIntakeValues(await reader.read("email-intake")),
    digest: async () => digestValues(await reader.read("digest")),
    async channels() {
      const current = await transports();
      const mode = (transport: { mode: "live" | "console" } | undefined) => transport?.mode ?? "off";
      return {
        slack: mode(current.slack),
        email: mode(current.email),
        webhook: webhookValues(await reader.read("webhook")) ? "live" : "off",
        ai: limits.AI_FAKE ? "console" : aiValues(await reader.read("ai")) ? "live" : "off",
        settings: reader.mode,
      };
    },
  };
}
