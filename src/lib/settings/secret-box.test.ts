import { describe, expect, it } from "vitest";
import { deriveSettingsKey, lastCharactersHint, openSecret, sealSecret, SecretError, urlHint } from "./secret-box";

const key = deriveSettingsKey("x".repeat(32));

describe("sealed secrets", () => {
  it("open with the same key and context only", () => {
    const sealed = sealSecret(key, "ai.apiKey", "sk-ant-secret-value");
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain("secret-value");
    expect(openSecret(key, "ai.apiKey", sealed)).toBe("sk-ant-secret-value");
    expect(() => openSecret(deriveSettingsKey("y".repeat(32)), "ai.apiKey", sealed)).toThrow(SecretError);
    expect(() => openSecret(key, "webhook.secret", sealed)).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => openSecret(key, "ai.apiKey", "v2:abc")).toThrow(SecretError);
  });

  it("seal the same value differently each time", () => {
    expect(sealSecret(key, "slack.botToken", "xoxb-1")).not.toBe(sealSecret(key, "slack.botToken", "xoxb-1"));
  });
});

describe("hints", () => {
  it("show the last four characters of a long secret only", () => {
    expect(lastCharactersHint("xoxb-1234567890-abcd")).toBe("…abcd");
    expect(lastCharactersHint("short-secret")).toBe("…");
  });

  it("hide the password of a URL", () => {
    expect(urlHint("smtps://library:p%40ss@mail.example.org:465")).toBe("smtps://library:****@mail.example.org:465");
    expect(urlHint("not a url")).toBe("…");
  });
});
