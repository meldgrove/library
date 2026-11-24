import { describe, expect, it } from "vitest";
import { legacyValues, presentVariables } from "./legacy-env";

describe("presentVariables", () => {
  it("lists the old variables that are set, by setting", () => {
    expect(presentVariables({ SMTP_URL: "smtp://mail.example.org", MAIL_FROM: " ", WEBHOOK_URL: "", SLACK_SIGNING_SECRET: "abc" })).toEqual({
      email: ["SMTP_URL"],
      slack: ["SLACK_SIGNING_SECRET"],
    });
  });

  it("counts neither the fake model nor the AI_PROVIDER default of an old compose.yaml", () => {
    expect(presentVariables({ AI_PROVIDER: "fake" })).toEqual({});
    expect(presentVariables({ AI_PROVIDER: "openai-compatible" })).toEqual({});
    expect(presentVariables({ AI_PROVIDER: "anthropic", AI_API_KEY: "k" }).ai).toEqual(["AI_PROVIDER", "AI_API_KEY"]);
  });
});

describe("legacyValues", () => {
  it("reads the settings from the old variables, as a worker without BETTER_AUTH_SECRET does", () => {
    const env = { SMTP_URL: "smtps://u:p@mail.example.org:465", MAIL_FROM: "library@example.org", EMAIL_INTAKE_IMAP_URL: "imaps://u:p@imap.example.org", EMAIL_INTAKE_DOMAINS: "Example.org, staff.example.org" };
    expect(legacyValues("email", env)).toMatchObject({ state: "set", values: { provider: "smtp", smtpUrl: "smtps://u:p@mail.example.org:465", from: "library@example.org" } });
    expect(legacyValues("email-intake", env).values.domains).toEqual(["example.org", "staff.example.org"]);
    expect(legacyValues("ai", { AI_PROVIDER: "openai-compatible", AI_API_KEY: "k", AI_MODEL: "m", AI_BASE_URL: "https://api.mistral.ai/v1" })).toMatchObject({
      state: "set",
      values: { provider: "openai-compatible", apiKey: "k" },
    });
  });

  it("leaves a setting off when its old variables are not valid", () => {
    expect(legacyValues("webhook", { WEBHOOK_URL: "https://hooks.example.org", WEBHOOK_SECRET: "short" }).state).toBe("not set");
    expect(legacyValues("digest", {}).state).toBe("not set");
  });
});
