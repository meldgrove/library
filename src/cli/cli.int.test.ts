import { spawn } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditEvent, workerHeartbeat } from "@/lib/db/schema";
import { SETTING_NAMES, type SettingName } from "@/lib/settings/definitions";
import { deriveSettingsKey } from "@/lib/settings/secret-box";
import type { TestDeps } from "@/lib/settings/tests";
import { connectTestDatabase } from "../../tests/integration/db";
import type { CliIo } from "./io";
import { runCli } from "./run";

const testDb = connectTestDatabase();
const db = testDb.db;
const SECRET = "c".repeat(32);
const key = deriveSettingsKey(SECRET);

const BODIES: Record<SettingName, Record<string, unknown>> = {
  ai: { provider: "anthropic", apiKey: "sk-ant-cli-key-0123456789-wxyz", model: "claude-opus-5-5" },
  email: { provider: "mailersend", mailersendToken: "mlsn.cli-token-0123456789", from: "library@example.org" },
  slack: { botToken: "xoxb-cli-bot-token-0123-abcd" },
  digest: { emailTo: "all-staff@example.org" },
  webhook: { url: "https://hooks.example.org/cli-path-token-3333", secret: "cli-webhook-secret-0123456789" },
  "email-intake": { imapUrl: "imaps://intake:cli-imap-pass-4444@imap.example.org:993", domains: ["example.org"] },
};
const SECRETS = ["sk-ant-cli-key-0123456789-wxyz", "mlsn.cli-token-0123456789", "xoxb-cli-bot-token-0123-abcd", "cli-path-token-3333", "cli-webhook-secret-0123456789", "cli-imap-pass-4444"];

/** Runs `cli <args>` in this process, with `stdin` as the body. */
async function cli(args: string[], options: { stdin?: string; withoutKey?: boolean; testDeps?: TestDeps } = {}) {
  let out = "";
  let err = "";
  const io: CliIo = { readStdin: async () => options.stdin ?? "", out: (text) => void (out += text), err: (text) => void (err += text) };
  const code = await runCli(args, io, () => ({ db, key: options.withoutKey ? null : key, testDeps: options.testDeps }));
  outputs.push(out, err);
  return { code, out, err, json: () => JSON.parse(out) as Record<string, unknown> };
}

let outputs: string[] = [];

beforeEach(async () => {
  await testDb.reset();
  outputs = [];
});

// Whatever a test did, no secret may show in the output.
afterEach(() => {
  for (const secret of SECRETS) expect(outputs.join("\n")).not.toContain(secret);
});

afterAll(() => testDb.close());

describe("cli settings", () => {
  it("applies, shows and lists each setting, with hints only", async () => {
    for (const name of SETTING_NAMES) {
      const applied = await cli(["settings", "apply", name], { stdin: JSON.stringify(BODIES[name]) });
      expect(applied, name).toMatchObject({ code: 0, err: "" });
      expect(applied.json().state, name).toBe("set");
      expect(await cli(["settings", "show", name])).toMatchObject({ code: 0, out: applied.out });
    }
    expect((await cli(["settings", "show", "ai"])).json()).toEqual({
      state: "set",
      provider: "anthropic",
      apiKey: { saved: true, hint: "…wxyz" },
      model: "claude-opus-5-5",
      baseUrl: null,
    });
    const list = await cli(["settings", "list"]);
    expect(list.code).toBe(0);
    expect(list.out.split("\n").filter(Boolean)).toEqual([
      "ai            set         anthropic, model claude-opus-5-5, key …wxyz",
      "email         set         MailerSend token …6789, from Meldgrove Library <library@example.org>",
      "slack         set         bot token …abcd, no signing secret (the Slack bot is off)",
      "digest        set         email all-staff@example.org",
      "webhook       set         https://hooks.example.org, secret …6789",
      "email-intake  set         imaps://…@imap.example.org:993, mailbox INBOX, domains example.org",
    ]);
    const rows = JSON.parse((await cli(["settings", "list", "--json"])).out) as { name: string; state: string }[];
    expect(rows.map(({ name, state }) => [name, state])).toEqual(SETTING_NAMES.map((name) => [name, "set"]));
  });

  it("records the operator and the command in the audit log", async () => {
    await cli(["settings", "apply", "webhook"], { stdin: JSON.stringify(BODIES.webhook) });
    const [entry] = await db.select().from(auditEvent).where(eq(auditEvent.subjectType, "setting"));
    expect(entry).toMatchObject({ actorId: null, action: "setting.changed", payload: { setting: "webhook", actor: "operator", command: "cli settings apply webhook", fields: ["url", "secret"] } });
  });

  it("refuses with the page's message and exit code 1", async () => {
    const refused = await cli(["settings", "apply", "email"], { stdin: JSON.stringify({ provider: "smtp", smtpUrl: "smtp://u:p@mail.example.org" }) });
    expect(refused).toMatchObject({ code: 1, out: "", err: "The email setting was not saved. Check from.\n  from: is required to send email\n" });
    const unknown = await cli(["settings", "apply", "slack"], { stdin: JSON.stringify({ "xoxb-cli-bot-token-0123-abcd": 1 }) });
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/fields that the slack setting does not have/);
  });

  it("answers a wrong command with exit code 2, and never repeats an argument", async () => {
    expect((await cli(["settings", "apply", "ai"], { stdin: "apiKey=sk-ant-cli-key-0123456789-wxyz" })).code).toBe(2);
    const argument = await cli(["settings", "apply", "ai", "sk-ant-cli-key-0123456789-wxyz"]);
    expect(argument).toMatchObject({ code: 2 });
    expect(argument.err).toMatch(/A body goes on stdin, never in an argument/);
    expect((await cli(["settings", "apply", "ai", "--key=sk-ant-cli-key-0123456789-wxyz"])).err).toMatch(/^Unknown option\./);
    expect((await cli(["settings", "remove", "ai", "--id", "1"])).code).toBe(2);
    expect((await cli(["settings", "show", "ai", "--id", "1"])).err).toMatch(/single setting: leave out --id/);
    expect((await cli(["settings", "show", "openai"])).err).toMatch(/Unknown setting\. The settings are ai, email, slack, digest, webhook, email-intake\./);
    expect((await cli(["settings", "test", "digest"])).code).toBe(2);
    expect((await cli(["settings", "test", "email"])).err).toMatch(/--to/);
    expect((await cli(["tokens", "create", "api-key"])).code).toBe(2);
    expect((await cli([])).code).toBe(2);
    expect(await cli(["help"])).toMatchObject({ code: 0, err: "" });
  });

  it("tests a setting as the page's button does", async () => {
    await cli(["settings", "apply", "slack"], { stdin: JSON.stringify(BODIES.slack) });
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 })) as unknown as typeof fetch;
    const failed = await cli(["settings", "test", "slack"], { testDeps: { fetchImpl } });
    expect(failed).toMatchObject({ code: 1, err: "Slack refused the bot token: invalid_auth.\n" });
    expect(failed.json()).toEqual({ ok: false, message: "Slack refused the bot token: invalid_auth." });

    await cli(["settings", "apply", "email"], { stdin: JSON.stringify(BODIES.email) });
    const sent: string[] = [];
    const emailTransport = () => ({ mode: "live" as const, kind: "mailersend", send: async (email: { to: string }) => void sent.push(email.to) });
    expect((await cli(["settings", "test", "email", "--to", "ada@example.org"], { testDeps: { emailTransport } })).code).toBe(0);
    expect(sent).toEqual(["ada@example.org"]);
  });

  it("cannot save or test without BETTER_AUTH_SECRET, but lists", async () => {
    const result = await cli(["settings", "apply", "digest"], { stdin: JSON.stringify(BODIES.digest), withoutKey: true });
    expect(result).toMatchObject({ code: 1 });
    expect(result.err).toMatch(/no BETTER_AUTH_SECRET/);
    expect((await cli(["settings", "list"], { withoutKey: true })).code).toBe(0);
  });

  it("says when the worker cannot read the settings, and what to do", async () => {
    expect((await cli(["settings", "list"])).out).not.toContain("worker");
    await db.insert(workerHeartbeat).values({ workerId: "w", startedAt: new Date(), beatAt: new Date(), channels: { slack: "off", email: "off", settings: "no key" } });
    expect((await cli(["settings", "list"])).out).toContain("The worker has no BETTER_AUTH_SECRET (a compose.yaml of 0.3.2 or earlier): it cannot read the secrets of these settings. Update compose.yaml.");
  });
});

describe("the command as a process", () => {
  /** Runs src/cli/main.ts with tsx, as `cli` does in the image. */
  function run(args: string[], stdin: string, env: Record<string, string> = {}) {
    return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(path.resolve("node_modules/.bin/tsx"), ["src/cli/main.ts", ...args], {
        env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, BETTER_AUTH_SECRET: SECRET, LOG_LEVEL: "debug", LIBRARY_PROCESS: "cli", NODE_ENV: "production", ...env },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("close", (code) => resolve({ code, out, err }));
      child.stdin.end(stdin);
    });
  }

  it("prints only the result on stdout, logs to stderr, and exits", async () => {
    const applied = await run(["settings", "apply", "webhook"], JSON.stringify(BODIES.webhook));
    outputs.push(applied.out, applied.err);
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.out)).toEqual({ state: "set", url: { saved: true, hint: "https://hooks.example.org" }, secret: { saved: true, hint: "…6789" } });
    const failed = await run(["settings", "apply", "webhook"], JSON.stringify({ url: "not a url" }));
    outputs.push(failed.out, failed.err);
    expect(failed).toMatchObject({ code: 1, out: "" });
    expect(failed.err).toContain("url: must be an http:// or https:// URL");

    // Without a database: the page's generic message, and the log line on stderr.
    const down = await run(["settings", "apply", "webhook"], JSON.stringify(BODIES.webhook), { DATABASE_URL: "postgres://library:library@127.0.0.1:9/library" });
    outputs.push(down.out, down.err);
    expect(down).toMatchObject({ code: 1, out: "" });
    expect(down.err).toMatch(/"msg":"cli failed"/);
    expect(down.err).toMatch(/Something went wrong/);
  }, 60_000);
});
