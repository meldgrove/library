import { eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CommandError } from "@/lib/commands";
import { appSetting, auditEvent } from "@/lib/db/schema";
import type { EmailTransport } from "@/lib/notifications/transports";
import { createWorkerIntegrations } from "@/workers/integrations";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { operator } from "./actor";
import { SETTING_NAMES, type SettingName } from "./definitions";
import { importLegacySettings, leftoverVariables, reportLeftovers } from "./legacy-env";
import { createSettingsReader } from "./runtime";
import { deriveSettingsKey } from "./secret-box";
import { applySetting, listSettings, showSetting } from "./service";
import { testSetting } from "./tests";

const testDb = connectTestDatabase();
const db = testDb.db;
const key = deriveSettingsKey("k".repeat(32));
let seed: Awaited<ReturnType<typeof seedDirectory>>;

/** A valid body per setting, with secrets that the tests look for everywhere. */
const BODIES: Record<SettingName, Record<string, unknown>> = {
  ai: { provider: "anthropic", apiKey: "sk-ant-api-key-0123456789-wxyz", model: "claude-opus-5-5" },
  email: { provider: "smtp", smtpUrl: "smtps://library:smtp-password-7777@mail.example.org:465", from: "library@example.org" },
  slack: { botToken: "xoxb-1111-2222-bot-token-abcd", signingSecret: "signing-secret-0123456789abcdef" },
  digest: { slackChannelId: "C0123456789", emailTo: "all-staff@example.org" },
  webhook: { url: "https://hooks.example.org/library", secret: "webhook-secret-0123456789" },
  "email-intake": { imapUrl: "imaps://intake:imap-password-5555@imap.example.org:993", domains: ["example.org"] },
};
const SECRETS = ["sk-ant-api-key-0123456789-wxyz", "smtp-password-7777", "xoxb-1111-2222-bot-token-abcd", "signing-secret-0123456789abcdef", "webhook-secret-0123456789", "imap-password-5555"];

const rows = async () => db.select().from(appSetting).where(like(appSetting.key, "integration.%"));
const audits = async () => db.select().from(auditEvent).where(eq(auditEvent.subjectType, "setting"));

beforeEach(async () => {
  await testDb.reset();
  seed = await seedDirectory(db);
});

afterAll(() => testDb.close());

describe("saving a setting", () => {
  it("saves each setting with the page's checks, seals its secrets, and shows only hints", async () => {
    for (const name of SETTING_NAMES) await applySetting(db, key, name, BODIES[name], seed.actors.amy);
    const stored = JSON.stringify(await rows());
    for (const secret of SECRETS) expect(stored).not.toContain(secret);
    expect(stored).toContain("v1:");

    const shown = JSON.stringify(await Promise.all(SETTING_NAMES.map((name) => showSetting(db, name, key))));
    for (const secret of SECRETS) expect(shown).not.toContain(secret);
    expect(await showSetting(db, "ai", key)).toEqual({
      state: "set",
      provider: "anthropic",
      apiKey: { saved: true, hint: "…wxyz" },
      model: "claude-opus-5-5",
      baseUrl: null,
    });
    expect(await showSetting(db, "email", key)).toMatchObject({ smtpUrl: { saved: true, hint: "smtps://library:****@mail.example.org:465" } });
    const list = await listSettings(db, key);
    expect(list.map(({ name }) => name)).toEqual(["ai", "email", "slack", "digest", "webhook", "email-intake"]);
    expect(list.every(({ state }) => state === "set")).toBe(true);
    expect(list.find((status) => status.name === "slack")!.hints).toEqual(["bot token …abcd", "signing secret …cdef"]);
  });

  it("refuses a body with the page's message and saves nothing", async () => {
    const error = await applySetting(db, key, "webhook", { url: "https://hooks.example.org/library" }, seed.actors.amy).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).fieldErrors).toEqual({ secret: "is required with a URL" });
    expect((error as CommandError).message).toBe("The webhook setting was not saved. Check secret.");
    expect(await showSetting(db, "webhook", key)).toMatchObject({ state: "not set", url: null });
    expect(await audits()).toEqual([]);
  });

  it("keeps a secret that the body leaves out, and removes it with null", async () => {
    await applySetting(db, key, "slack", BODIES.slack, seed.actors.amy);
    await applySetting(db, key, "slack", { signingSecret: null }, seed.actors.amy);
    expect(await showSetting(db, "slack", key)).toMatchObject({ botToken: { saved: true }, signingSecret: { saved: false, hint: null } });
  });

  it("audits who saved: the admin, or the operator with its command, and the fields, never values", async () => {
    await applySetting(db, key, "email", BODIES.email, seed.actors.amy);
    await applySetting(db, key, "email", { fromName: "Reading library" }, operator("cli settings apply email"));
    const [byAdmin, byOperator] = await audits();
    expect(byAdmin).toMatchObject({ actorId: seed.people.amy.id, action: "setting.changed", payload: { setting: "email", fields: ["provider", "smtpUrl", "from"] } });
    expect(byOperator).toMatchObject({ actorId: null, action: "setting.changed", payload: { setting: "email", fields: ["fromName"], actor: "operator", command: "cli settings apply email" } });
    expect(JSON.stringify(await audits())).not.toContain("smtp-password");
  });

  it("marks a secret that a new BETTER_AUTH_SECRET cannot open, and asks to enter it again", async () => {
    await applySetting(db, key, "webhook", BODIES.webhook, seed.actors.amy);
    const otherKey = deriveSettingsKey("o".repeat(32));
    const [status] = (await listSettings(db, otherKey)).filter((setting) => setting.name === "webhook");
    expect(status).toMatchObject({ state: "incomplete" });
    expect(status!.hints.at(-1)).toMatch(/secret cannot be read \(BETTER_AUTH_SECRET changed\): enter it again/);
    expect(await createSettingsReader(db, otherKey).read("webhook")).toMatchObject({ state: "incomplete", unreadable: ["secret"] });
  });
});

describe("running processes", () => {
  it("use a save at the next use, without a restart", async () => {
    const reader = createSettingsReader(db, key);
    const integrations = createWorkerIntegrations(reader, { NOTIFICATION_TRANSPORT: "live", LIBRARY_BASE_URL: "https://library.example.org" }, { AI_FAKE: false, AI_DAILY_LIMIT: 10, AI_TIMEOUT_MS: 1_000 });
    expect(await integrations.draftModel()).toBeNull();
    expect((await integrations.transports()).email).toBeUndefined();
    expect(await integrations.channels()).toEqual({ slack: "off", email: "off", webhook: "off", ai: "off", settings: "database" });

    await applySetting(db, key, "ai", BODIES.ai, seed.actors.amy);
    await applySetting(db, key, "email", BODIES.email, seed.actors.amy);
    expect((await integrations.draftModel())?.name).toBe("claude-opus-5-5");
    const first = await integrations.transports();
    expect(first.email?.kind).toBe("smtp");
    // Unchanged settings keep the transports; a change builds them again.
    expect(await integrations.transports()).toBe(first);
    await applySetting(db, key, "email", { provider: "mailersend", mailersendToken: "mlsn.0123456789abcdef" }, seed.actors.amy);
    expect((await integrations.transports()).email?.kind).toBe("mailersend");
    await applySetting(db, key, "ai", { model: "claude-sonnet-5-5" }, seed.actors.amy);
    expect((await integrations.draftModel())?.name).toBe("claude-sonnet-5-5");
  });
});

describe("old variables", () => {
  const OLD = {
    SLACK_BOT_TOKEN: "xoxb-9999-8888-old-token-wxyz",
    SMTP_URL: "smtp://mail.example.org:25",
    MAIL_FROM: "library@example.org",
    AI_PROVIDER: "openai-compatible",
    AI_API_KEY: "old-ai-key-0123456789",
    AI_MODEL: "mistral-medium-latest",
    AI_BASE_URL: "https://api.mistral.ai/v1",
    WEBHOOK_URL: "https://hooks.example.org/library",
    WEBHOOK_SECRET: "old-webhook-secret-0123",
    DIGEST_SLACK_CHANNEL_ID: "C0123456789",
    EMAIL_INTAKE_IMAP_URL: "imaps://intake:old-imap-pass@imap.example.org",
    EMAIL_INTAKE_DOMAINS: "example.org staff.example.org",
  };

  it("are copied into the database once, sealed, with an audit entry by the environment", async () => {
    const result = await importLegacySettings(db, key, OLD, "worker");
    expect(result.refused).toEqual([]);
    expect(result.imported.map(({ setting }) => setting).sort()).toEqual(["ai", "digest", "email", "email-intake", "slack", "webhook"]);
    expect(await showSetting(db, "ai", key)).toMatchObject({ state: "set", provider: "openai-compatible", model: "mistral-medium-latest", apiKey: { saved: true, hint: "…6789" } });
    expect(await showSetting(db, "email-intake", key)).toMatchObject({ state: "set", domains: ["example.org", "staff.example.org"], mailbox: null });
    expect(JSON.stringify(await rows())).not.toContain("old-ai-key");
    const imported = await audits();
    expect(imported).toHaveLength(6);
    expect(imported[0]).toMatchObject({ actorId: null, action: "setting.imported", payload: { actor: "environment", process: "worker" } });

    // A second start imports nothing: the database has the values.
    expect(await importLegacySettings(db, key, OLD, "worker")).toEqual({ imported: [], refused: [] });
    expect(await audits()).toHaveLength(6);
  });

  it("never overwrite what the database has, and stay ignored after an admin removed the value", async () => {
    await applySetting(db, key, "webhook", { url: "https://receiver.example.org/hook", secret: "page-secret-0123456789" }, seed.actors.amy);
    await importLegacySettings(db, key, OLD, "worker");
    expect(await showSetting(db, "webhook", key)).toMatchObject({ url: "https://receiver.example.org/hook", secret: { hint: "…6789" } });

    await applySetting(db, key, "slack", { botToken: null }, seed.actors.amy);
    await importLegacySettings(db, key, OLD, "worker");
    expect(await showSetting(db, "slack", key)).toMatchObject({ state: "not set", botToken: { saved: false } });
  });

  it("are imported wherever they are seen: the signing secret from web, the bot token from the worker", async () => {
    await importLegacySettings(db, key, { SLACK_SIGNING_SECRET: "old-signing-secret-0123" }, "web");
    expect(await showSetting(db, "slack", key)).toMatchObject({ state: "incomplete", signingSecret: { saved: true } });
    await importLegacySettings(db, key, { SLACK_BOT_TOKEN: OLD.SLACK_BOT_TOKEN }, "worker");
    expect(await showSetting(db, "slack", key)).toMatchObject({ state: "set", botToken: { hint: "…wxyz" }, signingSecret: { saved: true } });
  });

  it("are imported once when two processes start together", async () => {
    await Promise.all([importLegacySettings(db, key, OLD, "web"), importLegacySettings(db, key, OLD, "worker"), importLegacySettings(db, key, OLD, "migrate")]);
    expect(await audits()).toHaveLength(6);
  });

  it("that the database refuses are left for the next start, with the reason", async () => {
    await applySetting(db, key, "email", { provider: "mailersend", mailersendToken: "mlsn.0123456789abcdef", from: "a@example.org" }, seed.actors.amy);
    const result = await importLegacySettings(db, key, { SMTP_URL: OLD.SMTP_URL }, "worker");
    expect(result.refused).toEqual([{ setting: "email", variables: ["SMTP_URL"], message: expect.stringMatching(/provider must be "smtp"/) }]);
    expect(await showSetting(db, "email", key)).toMatchObject({ provider: "mailersend" });
  });

  it("still set are named per process, without values", async () => {
    await reportLeftovers(db, "worker", OLD);
    await reportLeftovers(db, "web", { SLACK_SIGNING_SECRET: "x" });
    const leftovers = await leftoverVariables(db);
    expect(leftovers).toContainEqual({ variable: "SLACK_BOT_TOKEN", processes: ["worker"] });
    expect(leftovers).toContainEqual({ variable: "SLACK_SIGNING_SECRET", processes: ["web"] });
    expect(JSON.stringify(leftovers)).not.toContain("old-ai-key");
    // A start without them clears the list.
    await reportLeftovers(db, "worker", {});
    expect((await leftoverVariables(db)).map(({ variable }) => variable)).toEqual(["SLACK_SIGNING_SECRET"]);
  });

  it("are what a worker without BETTER_AUTH_SECRET reads, as with a compose.yaml of 0.3.2 or earlier", async () => {
    await applySetting(db, key, "ai", BODIES.ai, seed.actors.amy);
    const integrations = createWorkerIntegrations(createSettingsReader(db, null, OLD), { NOTIFICATION_TRANSPORT: "live", LIBRARY_BASE_URL: "https://library.example.org" }, { AI_FAKE: false, AI_DAILY_LIMIT: 10, AI_TIMEOUT_MS: 1_000 });
    expect(integrations.mode).toBe("environment");
    expect((await integrations.draftModel())?.name).toBe("mistral-medium-latest");
    expect((await integrations.transports()).email?.kind).toBe("smtp");
    expect(await integrations.channels()).toMatchObject({ slack: "live", email: "live", webhook: "live", ai: "live", settings: "environment" });
  });
});

describe("tests", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("check Slack's bot token with auth.test", async () => {
    expect(await testSetting(db, key, "slack")).toEqual({ ok: false, message: "Slack is not set up yet: save the setting first." });
    await applySetting(db, key, "slack", BODIES.slack, seed.actors.amy);
    const calls: [string, RequestInit][] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push([String(url), init]);
      return ok({ ok: true, team: "Example", user: "library" });
    }) as unknown as typeof fetch;
    expect(await testSetting(db, key, "slack", {}, { fetchImpl })).toEqual({ ok: true, message: "Slack accepts the bot token: the bot library in the workspace Example." });
    expect(calls[0]![0]).toBe("https://slack.com/api/auth.test");
    expect((calls[0]![1].headers as Record<string, string>).Authorization).toBe("Bearer xoxb-1111-2222-bot-token-abcd");
    const refused = (async () => ok({ ok: false, error: "invalid_auth" })) as unknown as typeof fetch;
    expect(await testSetting(db, key, "slack", {}, { fetchImpl: refused })).toEqual({ ok: false, message: "Slack refused the bot token: invalid_auth." });
  });

  it("send a test email with the saved transport", async () => {
    await applySetting(db, key, "email", BODIES.email, seed.actors.amy);
    const sent: unknown[] = [];
    const emailTransport = (): EmailTransport => ({ mode: "live", kind: "smtp", send: async (email) => void sent.push(email) });
    await expect(testSetting(db, key, "email", {}, { emailTransport })).rejects.toBeInstanceOf(CommandError);
    expect(await testSetting(db, key, "email", { to: "ada@example.org" }, { emailTransport })).toEqual({ ok: true, message: "Sent a test email to ada@example.org with SMTP." });
    expect(sent).toEqual([expect.objectContaining({ to: "ada@example.org", subject: "Test email from Meldgrove Library" })]);
  });

  it("check the AI model with the smallest call, and the intake mailbox by signing in", async () => {
    await applySetting(db, key, "ai", { provider: "openai-compatible", apiKey: "mistral-key-0123456789", model: "mistral-medium-latest", baseUrl: "https://api.mistral.ai/v1" }, seed.actors.amy);
    let request: { url: string; body: unknown } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      request = { url: String(url), body: JSON.parse(String(init.body)) };
      return new Response("nope", { status: 401 });
    }) as unknown as typeof fetch;
    expect(await testSetting(db, key, "ai", {}, { fetchImpl })).toEqual({ ok: false, message: "The AI provider refused the API key (HTTP 401)." });
    expect(request).toEqual({ url: "https://api.mistral.ai/v1/chat/completions", body: expect.objectContaining({ model: "mistral-medium-latest", max_tokens: 1 }) });

    await applySetting(db, key, "email-intake", BODIES["email-intake"], seed.actors.amy);
    const checkMailbox = async (options: { url: string; mailbox: string }) => ({ ok: true, message: `checked ${options.mailbox} at ${new URL(options.url).hostname}` });
    expect(await testSetting(db, key, "email-intake", {}, { checkMailbox })).toEqual({ ok: true, message: "checked INBOX at imap.example.org" });
    await expect(testSetting(db, key, "digest")).rejects.toThrow("The digest setting has no test.");
  });
});
