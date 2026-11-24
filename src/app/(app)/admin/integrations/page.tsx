import { Alert, AlertDescription, AlertTitle } from "@meldgrove/ui/alert";
import { PageHeader } from "@meldgrove/ui/page";
import { CircleAlert } from "lucide-react";
import type { Metadata } from "next";
import { IntegrationForm, type IntegrationField } from "@/components/admin/integration-form";
import { requireAdmin } from "@/lib/auth/session";
import { getAiLimitsConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { SETTINGS_IN_ORDER, type SettingName } from "@/lib/settings/definitions";
import { LEGACY_VARIABLES, leftoverVariables, workerSettingsMode } from "@/lib/settings/legacy-env";
import { getSettingsKey } from "@/lib/settings/secret-box";
import { showSetting } from "@/lib/settings/service";
import { isTestable } from "@/lib/settings/tests";
import { saveSettingAction, testSettingAction } from "./actions";

export const metadata: Metadata = { title: "Integrations" };

/** What the page says about each setting and its fields; the rules are in `src/lib/settings/definitions.ts`. */
const PAGE: Record<SettingName, { description: string; fields: IntegrationField[] }> = {
  ai: {
    description:
      "The model that drafts a note for each upload: Anthropic's Claude API, or any OpenAI-compatible chat completions API (Mistral, OpenAI, Azure OpenAI, a self-hosted model). Until one is set up, uploads wait at the draft.",
    fields: [
      { name: "provider", label: "Provider", kind: "choice", options: [{ value: "anthropic", label: "Anthropic" }, { value: "openai-compatible", label: "OpenAI-compatible API" }] },
      { name: "apiKey", label: "API key", kind: "secret", required: true, showWhen: undefined },
      { name: "model", label: "Model", kind: "text", required: true, placeholder: "claude-opus-5-5", hint: "For example claude-opus-5-5, or mistral-medium-latest for Mistral." },
      { name: "baseUrl", label: "Base URL", kind: "text", required: true, placeholder: "https://api.mistral.ai/v1", hint: "Up to and including /v1.", showWhen: { field: "provider", value: "openai-compatible" } },
    ],
  },
  email: {
    description: "Emails about drafts, uploads on hold, reminders and digests: over SMTP or MailerSend's API.",
    fields: [
      { name: "provider", label: "Provider", kind: "choice", options: [{ value: "smtp", label: "SMTP" }, { value: "mailersend", label: "MailerSend" }] },
      {
        name: "smtpUrl",
        label: "SMTP URL",
        kind: "secret",
        required: true,
        placeholder: "smtps://user:password@mail.example.org:465",
        hint: "Host, port, TLS, user and password in one URL; special characters percent-encoded.",
        showWhen: { field: "provider", value: "smtp" },
      },
      { name: "mailersendToken", label: "MailerSend API token", kind: "secret", required: true, showWhen: { field: "provider", value: "mailersend" } },
      { name: "from", label: "Sender address", kind: "text", required: true, placeholder: "library@example.org" },
      { name: "fromName", label: "Sender name", kind: "text", placeholder: "Meldgrove Library" },
    ],
  },
  slack: {
    description:
      "Direct messages to people and posts to digest channels go out with the bot token. The signing secret switches on the Slack bot, which takes links and files that people send it.",
    fields: [
      { name: "botToken", label: "Bot token", kind: "secret", placeholder: "xoxb-…", hint: "OAuth & Permissions › Bot User OAuth Token." },
      { name: "signingSecret", label: "Signing secret", kind: "secret", hint: "Basic Information › App Credentials. Only for the Slack bot." },
    ],
  },
  digest: {
    description: "The weekly digest of new notes for everyone, on Mondays at 09:00: a Slack channel and an email address, such as a list. Teams set their own channel under Teams.",
    fields: [
      { name: "slackChannelId", label: "Slack channel ID", kind: "text", placeholder: "C0123456789", hint: "Invite the Slack app to the channel." },
      { name: "emailTo", label: "Email address", kind: "text", placeholder: "all-staff@example.org" },
    ],
  },
  webhook: {
    description:
      "Published notes that are not private go to this URL within a minute of each change, for example to a search index or an AI assistant. Each request is signed with the secret (see docs/webhooks.md).",
    fields: [
      { name: "url", label: "URL", kind: "text", placeholder: "https://hooks.example.org/library" },
      { name: "secret", label: "Signing secret", kind: "secret", hint: "At least 16 characters, for example from openssl rand -hex 32. The receiver checks the signature with it." },
    ],
  },
  "email-intake": {
    description: "A mailbox that staff forward sources to. The worker reads it every 2 minutes over IMAP and takes mail only from the domains below.",
    fields: [
      { name: "imapUrl", label: "IMAP URL", kind: "secret", placeholder: "imaps://library-intake:password@imap.example.org:993", hint: "User and password in the URL; special characters percent-encoded." },
      { name: "domains", label: "Sender domains", kind: "list", placeholder: "example.org, staff.example.org", hint: "Separated by commas. Mail from other domains is ignored." },
      { name: "mailbox", label: "Mailbox", kind: "text", placeholder: "INBOX" },
      { name: "doneMailbox", label: "Mailbox for handled messages", kind: "text", hint: "Without one, handled messages stay in the mailbox, marked as read." },
    ],
  },
};

export default async function IntegrationsPage() {
  const user = await requireAdmin();
  const key = getSettingsKey();
  const [views, leftovers, workerMode] = await Promise.all([
    Promise.all(SETTINGS_IN_ORDER.map((definition) => showSetting(getDb(), definition.name, key))),
    leftoverVariables(getDb()),
    workerSettingsMode(getDb()),
  ]);
  const fake = getAiLimitsConfig().AI_FAKE;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Integrations"
        description="The services the library works with. Operators can set the same settings on the server with `cli settings` (docs/deployment.md)."
      />

      {workerMode === "environment" ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>The worker does not read these settings yet</AlertTitle>
          <AlertDescription>
            It was started with a compose.yaml of version 0.3.2 or earlier, which does not pass BETTER_AUTH_SECRET to it, so it reads the old
            variables from .env instead. Update compose.yaml on the server and run docker compose up -d (docs/deployment.md, Upgrades).
          </AlertDescription>
        </Alert>
      ) : null}

      {SETTINGS_IN_ORDER.map((definition, index) => {
        const old = leftovers.filter(({ variable }) => variable in LEGACY_VARIABLES[definition.name]);
        const notices = [
          ...(old.length > 0
            ? [
                `${old.map(({ variable, processes }) => `${variable} (${processes.join(", ")})`).join(", ")} ${old.length === 1 ? "is" : "are"} still set on the server. ${
                  workerMode === "environment" ? "The worker reads them until compose.yaml is updated." : "The library no longer reads them: delete them from .env."
                }`,
              ]
            : []),
          ...(definition.name === "ai" && fake ? ["AI_PROVIDER=fake is set: the worker drafts with the fake model (development and tests) and ignores this setting."] : []),
        ];
        return (
          <IntegrationForm
            key={definition.name}
            name={definition.name}
            title={definition.title}
            description={PAGE[definition.name].description}
            fields={PAGE[definition.name].fields}
            initialView={views[index]!}
            save={saveSettingAction}
            test={isTestable(definition.name) ? testSettingAction : undefined}
            testAddress={definition.name === "email" ? (user.person.workEmail ?? undefined) : undefined}
            notices={notices}
          />
        );
      })}
    </div>
  );
}
