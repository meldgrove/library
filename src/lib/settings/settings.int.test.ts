import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandError } from "@/lib/commands";
import { appSetting, auditEvent, notificationDelivery, webhookSync } from "@/lib/db/schema";
import { emailToAddress, postToChannel } from "@/lib/library/notify";
import { dispatchDue } from "@/lib/notifications/dispatch";
import { DeliveryError, type EmailTransport } from "@/lib/notifications/transports";
import { noteRemovedPayload } from "@/lib/webhook/payload";
import { createWorkerIntegrations } from "@/workers/integrations";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { operator } from "./actor";
import { SETTING_NAMES, type SettingName } from "./definitions";
import { createSettingsReader, webhookValues } from "./runtime";
import { deriveSettingsKey } from "./secret-box";
import { applySetting, listSettings, sealWebhookUrl, showSetting } from "./service";
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
  webhook: { url: "https://hooks.example.org/webhook-path-token-8888", secret: "webhook-secret-0123456789" },
  "email-intake": { imapUrl: "imaps://intake:imap-password-5555@imap.example.org:993", domains: ["example.org"] },
};
const SECRETS = ["sk-ant-api-key-0123456789-wxyz", "smtp-password-7777", "xoxb-1111-2222-bot-token-abcd", "signing-secret-0123456789abcdef", "webhook-path-token-8888", "webhook-secret-0123456789", "imap-password-5555"];

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
    expect(await showSetting(db, "email", key)).toMatchObject({ smtpUrl: { saved: true, hint: "smtps://…@mail.example.org:465" } });
    const list = await listSettings(db, key);
    expect(list.map(({ name }) => name)).toEqual(["ai", "email", "slack", "digest", "webhook", "email-intake"]);
    expect(list.every(({ state }) => state === "set")).toBe(true);
    expect(list.find((status) => status.name === "slack")!.hints).toEqual(["bot token …abcd", "signing secret …cdef"]);
    expect(list.find((status) => status.name === "webhook")!.hints).toEqual(["https://hooks.example.org", "secret …6789"]);
    for (const secret of SECRETS) expect(JSON.stringify([list, await audits()])).not.toContain(secret);
  });

  it("refuses a body with the page's message and saves nothing", async () => {
    const error = await applySetting(db, key, "webhook", { url: "https://hooks.example.org/library" }, seed.actors.amy).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).fieldErrors).toEqual({ secret: "is required with a URL" });
    expect((error as CommandError).message).toBe("The webhook setting was not saved. Check secret.");
    expect(await showSetting(db, "webhook", key)).toMatchObject({ state: "not set", url: { saved: false, hint: null } });
    expect(await audits()).toEqual([]);
  });

  it("is for admins only, unless the operator saves", async () => {
    await expect(applySetting(db, key, "digest", BODIES.digest, seed.actors.dan)).rejects.toMatchObject({ code: "forbidden" });
    expect(await showSetting(db, "digest", key)).toMatchObject({ state: "not set" });
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
    expect(status!.hints.at(-1)).toMatch(/^url, secret cannot be read \(BETTER_AUTH_SECRET changed\): enter them again$/);
    expect(await showSetting(db, "webhook", otherKey)).toMatchObject({ state: "incomplete", url: { saved: true, hint: "https://hooks.example.org" } });
    const values = await createSettingsReader(db, otherKey).read("webhook");
    expect(values.unreadable).toEqual(["url", "secret"]);
    expect(webhookValues(values)).toBeNull();
    // Entered again, both can be read.
    expect(await applySetting(db, otherKey, "webhook", BODIES.webhook, seed.actors.amy)).toMatchObject({ state: "set" });
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

describe("a changed BETTER_AUTH_SECRET", () => {
  it("makes messages wait for the secrets to be entered again, and skips none", async () => {
    await applySetting(db, key, "email", BODIES.email, seed.actors.amy);
    await applySetting(db, key, "slack", BODIES.slack, seed.actors.amy);
    const message = { subject: "Digest", title: "Weekly library digest", text: "1 new note.", path: "/" };
    await postToChannel(db, { event: "weekly_digest", key: "2026-W47:all", channelId: "C0123456789", message });
    await emailToAddress(db, { event: "weekly_digest", key: "2026-W47:all", address: "all-staff@example.org", message });
    const otherKey = deriveSettingsKey("o".repeat(32));
    const integrations = createWorkerIntegrations(createSettingsReader(db, otherKey), { NOTIFICATION_TRANSPORT: "live", LIBRARY_BASE_URL: "https://library.example.org" }, { AI_FAKE: false, AI_DAILY_LIMIT: 10, AI_TIMEOUT_MS: 1_000 });
    expect(await integrations.channels()).toMatchObject({ slack: "off", email: "off" });
    expect(await dispatchDue(db, await integrations.transports())).toEqual({ sent: 0, skipped: 0, retry: 2, failed: 0 });
    const rows = await db.select().from(notificationDelivery);
    expect(rows.map((row) => [row.channel, row.status, row.lastError]).sort()).toEqual([
      ["email_address", "pending", "The SMTP URL cannot be read: enter it again under Admin › Integrations."],
      ["slack_channel", "pending", "The Slack bot token cannot be read: enter it again under Admin › Integrations."],
    ]);
    // A channel that is turned off skips its messages as before.
    await applySetting(db, otherKey, "email", { provider: null }, seed.actors.amy);
    expect((await integrations.transports()).email).toBeUndefined();
  });
});

describe("the webhook's URL", () => {
  const URL_030 = "https://hooks.example.org/library/url-path-token?key=url-query-token";
  const payload = noteRemovedPayload("n1");

  /** The webhook as 0.3.3 and 0.3.4 saved it: the URL as plain text, the secret sealed. */
  async function saveAsIn034() {
    await applySetting(db, key, "webhook", { ...BODIES.webhook, url: URL_030 }, seed.actors.amy);
    const [row] = await db.select().from(appSetting).where(eq(appSetting.key, "integration.webhook"));
    await db.update(appSetting).set({ value: { ...(row!.value as object), url: URL_030 } }).where(eq(appSetting.key, "integration.webhook"));
  }

  const worker = (settingsKey: Buffer | null) =>
    createWorkerIntegrations(createSettingsReader(db, settingsKey), { NOTIFICATION_TRANSPORT: "live", LIBRARY_BASE_URL: "https://library.example.org" }, { AI_FAKE: false, AI_DAILY_LIMIT: 10, AI_TIMEOUT_MS: 1_000 });

  it("is kept when a body leaves it out, and turns the webhook off with null", async () => {
    await applySetting(db, key, "webhook", { ...BODIES.webhook, url: URL_030 }, seed.actors.amy);
    for (const body of [{ secret: "another-secret-0123456789" }, { url: "" }]) {
      expect(await applySetting(db, key, "webhook", body, seed.actors.amy)).toMatchObject({ state: "set", url: { saved: true, hint: "https://hooks.example.org" } });
    }
    expect(webhookValues(await createSettingsReader(db, key).read("webhook"))).toEqual({ url: URL_030, secret: "another-secret-0123456789" });
    expect(JSON.stringify(await audits())).not.toContain("token");
    expect(await applySetting(db, key, "webhook", { url: null }, seed.actors.amy)).toMatchObject({ state: "not set", url: { saved: false, hint: null }, secret: { saved: false } });
  });

  it("of 0.3.4 is sealed once at start, and delivers before and after", async () => {
    await saveAsIn034();
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      requested.push(url);
      return new Response(null, { status: 204 });
    });
    try {
      // Not sealed yet, such as by a web process that is still the old one: shown as a hint only.
      await (await worker(key).webhookClient())!.send(payload);
      expect(await showSetting(db, "webhook", key)).toMatchObject({ state: "set", url: { saved: true, hint: "https://hooks.example.org" } });
      expect(JSON.stringify(await listSettings(db, key))).not.toContain("token");

      // Two processes that start together seal it once.
      expect((await Promise.all([sealWebhookUrl(db, key), sealWebhookUrl(db, key)])).sort()).toEqual([false, true]);
      const sealed = await rows();
      expect(JSON.stringify(sealed)).not.toContain("token");
      expect(await sealWebhookUrl(db, key)).toBe(false);
      expect(await rows()).toEqual(sealed);
      expect(await showSetting(db, "webhook", key)).toMatchObject({ state: "set", url: { saved: true, hint: "https://hooks.example.org" } });
      await (await worker(key).webhookClient())!.send(payload);
      expect(requested).toEqual([URL_030, URL_030]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["saved", "off"])("is gone from the stored delivery errors of 0.3.4 after the start (webhook %s)", async (webhook) => {
    if (webhook === "saved") await saveAsIn034();
    const [quoting, cut, other, today] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const refused = "Request to https://hooks.example.org failed: Request cannot be constructed from a URL that includes credentials: https://";
    await db.insert(webhookSync).values([
      { noteId: quoting, action: "publish", lastError: `${refused}user:old-token@hooks.example.org/path` },
      { noteId: cut, action: "publish", lastError: `${refused}user:old-tok` },
      { noteId: other, action: "publish", lastError: "The webhook answered HTTP 500" },
      { noteId: today, action: "publish", lastError: `${refused}hooks.example.org` },
    ]);
    expect(await sealWebhookUrl(db, key)).toBe(webhook === "saved");
    const errors = await db.select({ noteId: webhookSync.noteId, lastError: webhookSync.lastError }).from(webhookSync);
    expect(new Map(errors.map((row) => [row.noteId, row.lastError]))).toEqual(new Map([[quoting, null], [cut, null], [other, "The webhook answered HTTP 500"], [today, `${refused}hooks.example.org`]]));
  });

  it("is off without a webhook, also after the start", async () => {
    expect(await sealWebhookUrl(db, key)).toBe(false);
    expect(await showSetting(db, "webhook", key)).toMatchObject({ state: "not set" });
    expect(await worker(key).webhookClient()).toBeNull();
  });
});

describe("a worker without BETTER_AUTH_SECRET (a compose.yaml of 0.3.2 or earlier)", () => {
  it("starts, cannot read any secret, and reports it", async () => {
    for (const name of SETTING_NAMES) await applySetting(db, key, name, BODIES[name], seed.actors.amy);
    const integrations = createWorkerIntegrations(createSettingsReader(db, null), { NOTIFICATION_TRANSPORT: "live", LIBRARY_BASE_URL: "https://library.example.org" }, { AI_FAKE: false, AI_DAILY_LIMIT: 10, AI_TIMEOUT_MS: 1_000 });
    expect(await integrations.channels()).toEqual({ slack: "off", email: "off", webhook: "off", ai: "off", settings: "no key" });
    expect((await integrations.transports()).email?.mode).toBe("unreadable");
    expect(await integrations.draftModel()).toBeNull();
    expect(await integrations.webhookClient()).toBeNull();
    expect(await integrations.emailIntake()).toBeNull();
    // What is no secret still counts.
    expect(await integrations.digest()).toEqual({ slackChannelId: "C0123456789", emailTo: "all-staff@example.org" });
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
    // The mail server's own reply, without the login; a failure without a reply has only its code.
    const failing = (error: DeliveryError) => (): EmailTransport => ({
      mode: "live",
      kind: "smtp",
      send: async () => {
        throw error;
      },
    });
    const to = { to: "ada@example.org" };
    expect(await testSetting(db, key, "email", to, { emailTransport: failing(new DeliveryError("SMTP 550: mailbox pw smtp-password-7777 unknown", { reply: "550 5.7.1 mailbox pw *** unknown" })) })).toEqual({
      ok: false,
      message: 'The email was not sent: the mail server answered "550 5.7.1 mailbox pw *** unknown".',
    });
    expect((await testSetting(db, key, "email", to, { emailTransport: failing(new DeliveryError("SMTP 535: no for library:x", { code: "EAUTH", reply: "535 5.7.8 no for ***:x" })) })).message).toBe(
      'The email was not sent: the mail server refused the user or password. It answered "535 5.7.8 no for ***:x".',
    );
    expect((await testSetting(db, key, "email", to, { emailTransport: failing(new DeliveryError("EAUTH: Missing credentials", { code: "EAUTH" })) })).message).toBe(
      "The email was not sent: the mail server refused the user or password.",
    );
    expect((await testSetting(db, key, "email", to, { emailTransport: failing(new DeliveryError("SMTP 500: Invalid HELO: 500 internal", { code: "EPROTOCOL" })) })).message).toBe(
      "The email was not sent: the server answered 500.",
    );
    expect((await testSetting(db, key, "email", to, { emailTransport: failing(new DeliveryError("ECONNREFUSED: x", { code: "ECONNECTION" })) })).message).toBe(
      "The email was not sent: the mail server could not be reached (ECONNECTION).",
    );
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
