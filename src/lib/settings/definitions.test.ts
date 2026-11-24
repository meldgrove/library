import { describe, expect, it } from "vitest";
import { emptyFields, parseBody, SETTINGS, viewOf, type StoredFields } from "./definitions";

const sealed = (hint: string) => ({ sealed: "v1:x", hint });

/** Applies a body as the service does, without sealing: secrets get a fake sealed value. */
function apply(name: keyof typeof SETTINGS, previous: StoredFields, body: unknown) {
  const definition = SETTINGS[name];
  const { changes, errors } = parseBody(definition, body);
  const next: StoredFields = { ...emptyFields(definition), ...previous };
  // As the service: a body that does not parse is refused before the rules across fields.
  if (Object.keys(errors).length > 0) return { errors, next };
  for (const [field, change] of changes) {
    const spec = definition.fields[field]!;
    if (change.op === "clear") next[field] = spec.kind === "list" ? [] : null;
    else next[field] = spec.kind === "secret" ? sealed(spec.hint(change.value as string)) : change.value;
  }
  return { errors: definition.finish({ ...emptyFields(definition), ...previous }, next, changes), next };
}

describe("bodies", () => {
  it("keep an omitted or empty secret, replace it with a string, and remove it with null", () => {
    const previous = { botToken: sealed("…old1"), signingSecret: sealed("…old2") };
    expect(apply("slack", previous, {}).next.botToken).toEqual(sealed("…old1"));
    expect(apply("slack", previous, { botToken: "" }).next.botToken).toEqual(sealed("…old1"));
    expect(apply("slack", previous, { botToken: "xoxb-0000000000-new1" }).next.botToken).toEqual(sealed("…new1"));
    expect(apply("slack", previous, { signingSecret: null }).next.signingSecret).toBeNull();
  });

  it("refuse fields the setting does not have, without naming them", () => {
    const { errors } = parseBody(SETTINGS.slack, { "xoxb-pasted-into-a-key": true, botToken: "xoxb-1" });
    expect(errors.form).toMatch(/fields that the slack setting does not have/);
    expect(errors.form).not.toContain("pasted");
    expect(parseBody(SETTINGS.slack, ["xoxb-1"]).errors.form).toBe("The body must be a JSON object.");
  });

  it("never repeat a refused value", () => {
    const { errors } = parseBody(SETTINGS.slack, { botToken: "xoxp-user-token-123" });
    expect(errors.botToken).toBe("must be a Slack bot token (xoxb-…)");
    const intake = parseBody(SETTINGS["email-intake"], { imapUrl: "imaps://imap.example.org", domains: ["not a domain"] });
    expect(intake.errors).toEqual({ imapUrl: "needs the user and password in the URL", domains: "must be domain names such as example.org" });
    expect(JSON.stringify(intake.errors)).not.toContain("not a domain");
  });

  it("clear other fields with null or an empty string", () => {
    const { next } = apply("digest", { slackChannelId: "C0123456789", emailTo: "all@example.org" }, { slackChannelId: "", emailTo: null });
    expect(next).toMatchObject({ slackChannelId: null, emailTo: null });
  });
});

describe("email", () => {
  it("needs the provider's secret and a sender, and keeps only the provider's secret", () => {
    expect(apply("email", {}, { provider: "smtp" }).errors).toEqual({ smtpUrl: "is required for SMTP", from: "is required to send email" });
    const smtp = apply("email", {}, { provider: "smtp", smtpUrl: "smtps://u:p@mail.example.org:465", from: "Library@Example.org" });
    expect(smtp.errors).toEqual({});
    expect(smtp.next).toMatchObject({ provider: "smtp", smtpUrl: sealed("smtps://…@mail.example.org:465"), from: "library@example.org" });
    const switched = apply("email", smtp.next, { provider: "mailersend", mailersendToken: "mlsn.0123456789abcdef" });
    expect(switched.errors).toEqual({});
    expect(switched.next.smtpUrl).toBeNull();
    expect(apply("email", smtp.next, { provider: null }).next).toMatchObject({ provider: null, smtpUrl: null, mailersendToken: null });
  });

  it("refuses a secret of the other provider", () => {
    expect(apply("email", {}, { mailersendToken: "mlsn.0123456789abcdef", from: "a@example.org" }).errors.provider).toMatch(/must be "mailersend"/);
    expect(apply("email", {}, { provider: "smtp", smtpUrl: "https://mail.example.org", from: "a@example.org" }).errors.smtpUrl).toBe("must be an smtp:// or smtps:// URL");
  });
});

describe("ai", () => {
  const anthropic = { provider: "anthropic", apiKey: sealed("…abcd"), model: "claude-opus-5-5", baseUrl: null };

  it("needs a key and a model, and a base URL for an OpenAI-compatible API", () => {
    expect(apply("ai", {}, { provider: "anthropic" }).errors).toEqual({ apiKey: "is required", model: "is required" });
    expect(apply("ai", {}, { provider: "openai-compatible", apiKey: "k", model: "m" }).errors.baseUrl).toMatch(/is required/);
    expect(apply("ai", {}, { provider: "openai-compatible", apiKey: "k", model: "m", baseUrl: "https://api.mistral.ai/v1/" }).next.baseUrl).toBe("https://api.mistral.ai/v1");
  });

  it("needs a new key when the provider changes, and drops the key when it is switched off", () => {
    expect(apply("ai", anthropic, { model: "claude-sonnet-5-5" }).errors).toEqual({});
    expect(apply("ai", anthropic, { provider: "openai-compatible", baseUrl: "https://api.mistral.ai/v1" }).errors.apiKey).toBe("is required when the provider changes");
    expect(apply("ai", anthropic, { provider: null }).next.apiKey).toBeNull();
  });
});

describe("webhook and email intake", () => {
  it("need a secret with a URL, and domains with a mailbox", () => {
    expect(apply("webhook", {}, { url: "https://hooks.example.org/library" }).errors).toEqual({ secret: "is required with a URL" });
    expect(apply("webhook", {}, { url: "https://hooks.example.org/library", secret: "short" }).errors.secret).toBe("must be at least 16 characters");
    expect(apply("webhook", { url: "https://hooks.example.org", secret: sealed("…") }, { url: null }).next.secret).toBeNull();
    // The receiver's URL as given: requests are not redirected.
    expect(apply("webhook", {}, { url: "https://hooks.example.org/events/", secret: "0123456789abcdef" }).next.url).toBe("https://hooks.example.org/events/");
    expect(apply("email-intake", {}, { imapUrl: "imaps://u:p@imap.example.org" }).errors.domains).toMatch(/is required/);
    expect(apply("email-intake", {}, { imapUrl: "imaps://u:p@imap.example.org", domains: ["@Example.org", "staff.example.org"] }).next.domains).toEqual([
      "example.org",
      "staff.example.org",
    ]);
  });
});

describe("views and states", () => {
  it("show hints for secrets, never their sealed values", () => {
    const view = viewOf(SETTINGS.slack, { botToken: sealed("…abcd"), signingSecret: null });
    expect(view).toEqual({ state: "set", botToken: { saved: true, hint: "…abcd" }, signingSecret: { saved: false, hint: null } });
    expect(JSON.stringify(view)).not.toContain("v1:");
    expect(SETTINGS.slack.status({ botToken: null, signingSecret: sealed("…") }).state).toBe("incomplete");
    expect(SETTINGS.email.status({ ...emptyFields(SETTINGS.email) }).state).toBe("not set");
  });
});
