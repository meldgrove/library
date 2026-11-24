import { z } from "zod";
import { CommandError } from "@/lib/commands";
import { getAiLimitsConfig } from "@/lib/config";
import type { Database } from "@/lib/db/client";
import { checkImapMailbox } from "@/lib/email/imap";
import { checkDraftModel } from "@/lib/library/draft";
import { checkSlackToken, createEmailTransport, DeliveryError, type CheckResult, type EmailTransport } from "@/lib/notifications/transports";
import type { SettingName } from "./definitions";
import { aiValues, emailIntakeValues, emailValues, slackValues, type EmailValues } from "./runtime";
import { loadSettingValues } from "./service";

/*
 * The test buttons of Admin › Integrations, and `cli settings test`. Each
 * uses the saved setting, as the worker would, and changes nothing.
 */

/** The settings with a test. */
export const TESTABLE_SETTINGS = ["slack", "email", "ai", "email-intake"] as const satisfies readonly SettingName[];
export type TestableSetting = (typeof TESTABLE_SETTINGS)[number];
export const isTestable = (name: SettingName): name is TestableSetting => (TESTABLE_SETTINGS as readonly string[]).includes(name);

export interface TestOptions {
  /** `email`: where the test email goes. */
  to?: string;
}

/** Stand-ins for tests. */
export interface TestDeps {
  fetchImpl?: typeof fetch;
  emailTransport?: (email: EmailValues) => EmailTransport;
  checkMailbox?: typeof checkImapMailbox;
  checkModel?: typeof checkDraftModel;
}

const notSet = (what: string): CheckResult => ({ ok: false, message: `${what} is not set up yet: save the setting first.` });

export async function testSetting(db: Database, key: Buffer, name: SettingName, options: TestOptions = {}, deps: TestDeps = {}): Promise<CheckResult> {
  if (!isTestable(name)) throw new CommandError("invalid", `The ${name} setting has no test.`);
  const values = await loadSettingValues(db, key, name);
  if (values.unreadable.length > 0) {
    return { ok: false, message: `The saved ${values.unreadable.join(", ")} cannot be read (BETTER_AUTH_SECRET changed): enter it again.` };
  }
  switch (name) {
    case "slack": {
      const { botToken } = slackValues(values);
      return botToken ? checkSlackToken(botToken, deps.fetchImpl) : notSet("Slack");
    }
    case "email": {
      const address = z.email().safeParse(options.to?.trim() ?? "");
      if (!address.success) throw new CommandError("invalid", "Enter the address for the test email.", { to: "must be an email address" });
      const email = emailValues(values);
      if (!email) return notSet("Email");
      const transport = (deps.emailTransport ?? createEmailTransport)(email);
      try {
        await transport.send({
          to: address.data,
          subject: "Test email from Meldgrove Library",
          text: "This email tests the email settings of Meldgrove Library. Nothing else needs to be done.",
          html: "<p>This email tests the email settings of Meldgrove Library. Nothing else needs to be done.</p>",
        });
      } catch (error) {
        return { ok: false, message: error instanceof DeliveryError ? `The email was not sent. ${error.message}` : "The email was not sent." };
      }
      return { ok: true, message: `Sent a test email to ${address.data} with ${email.provider === "smtp" ? "SMTP" : "MailerSend"}.` };
    }
    case "ai": {
      const ai = aiValues(values);
      if (!ai) return notSet("The AI model");
      const timeoutMs = getAiLimitsConfig().AI_TIMEOUT_MS;
      const check = deps.checkModel ?? checkDraftModel;
      return ai.provider === "anthropic"
        ? check({ AI_PROVIDER: "anthropic", AI_API_KEY: ai.apiKey, AI_MODEL: ai.model, AI_TIMEOUT_MS: timeoutMs })
        : check({ AI_PROVIDER: "openai-compatible", AI_BASE_URL: ai.baseUrl!, AI_API_KEY: ai.apiKey, AI_MODEL: ai.model, AI_TIMEOUT_MS: timeoutMs }, { fetchImpl: deps.fetchImpl });
    }
    case "email-intake": {
      const intake = emailIntakeValues(values);
      if (!intake) return notSet("The email intake");
      return (deps.checkMailbox ?? checkImapMailbox)({ url: intake.imapUrl, mailbox: intake.mailbox, doneMailbox: intake.doneMailbox });
    }
  }
}
