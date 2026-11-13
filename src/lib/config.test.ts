import { describe, expect, it } from "vitest";
import {
  ConfigError,
  parseAuthConfig,
  parseDirectoryConfig,
  parseErrorReportingConfig,
  parseVersionConfig,
  parseNotificationConfig,
  parseAiConfig,
  parseDigestConfig,
  parseEmailIntakeConfig,
  parseSlackIntakeConfig,
  parseOcrConfig,
  parseStorageConfig,
  parseUploadConfig,
  parseWebhookConfig,
  validateWebConfig,
  validateWorkerConfig,
} from "./config";

const auth = {
  LIBRARY_BASE_URL: "https://library.example.org/",
  BETTER_AUTH_SECRET: "x".repeat(32),
  OIDC_ISSUER: "https://auth.example.org/realms/acme/",
  OIDC_CLIENT_ID: "library",
  OIDC_CLIENT_SECRET: "secret",
};

const keycloakDirectory = {
  DIRECTORY: "keycloak",
  OIDC_ISSUER: "https://auth.example.org/realms/acme",
  OIDC_CLIENT_ID: "library",
  OIDC_CLIENT_SECRET: "secret",
  KEYCLOAK_ACCESS_GROUP: "/library",
  KEYCLOAK_ADMIN_GROUP: "/library-admins",
  KEYCLOAK_TEAMS_GROUP: "/teams",
};

const manualDirectory = { INITIAL_ADMIN_EMAILS: "owner@example.org" };

describe("parseAuthConfig", () => {
  it("strips trailing slashes from URLs and defaults the scopes", () => {
    const config = parseAuthConfig(auth);
    expect(config.LIBRARY_BASE_URL).toBe("https://library.example.org");
    expect(config.OIDC_ISSUER).toBe("https://auth.example.org/realms/acme");
    expect(config.OIDC_SCOPES).toBe("openid profile email");
  });

  it("treats blank values as missing", () => {
    expect(() => parseAuthConfig({ ...auth, OIDC_CLIENT_SECRET: "  " })).toThrow(/OIDC_CLIENT_SECRET/);
  });

  it("requires a long secret, and not the example one in production", () => {
    expect(() => parseAuthConfig({ ...auth, BETTER_AUTH_SECRET: "short" })).toThrow(/at least 32/);
    const example = { ...auth, BETTER_AUTH_SECRET: "development-secret-development-secret" };
    expect(() => parseAuthConfig(example)).not.toThrow();
    expect(() => parseAuthConfig({ ...example, NODE_ENV: "production" })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("has no default identity provider", () => {
    expect(() => parseAuthConfig({ ...auth, OIDC_ISSUER: undefined })).toThrow(/OIDC_ISSUER/);
  });

  it("names the provider on the sign-in button only when set", () => {
    expect(parseAuthConfig(auth).OIDC_PROVIDER_NAME).toBeUndefined();
    expect(parseAuthConfig({ ...auth, OIDC_PROVIDER_NAME: " Microsoft " }).OIDC_PROVIDER_NAME).toBe("Microsoft");
    expect(() => parseAuthConfig({ ...auth, OIDC_PROVIDER_NAME: "x".repeat(41) })).toThrow(/OIDC_PROVIDER_NAME/);
  });

  it("trusts the provider's email addresses only when told to", () => {
    expect(parseAuthConfig(auth).OIDC_TRUST_EMAIL).toBe(false);
    expect(parseAuthConfig({ ...auth, OIDC_TRUST_EMAIL: "true" }).OIDC_TRUST_EMAIL).toBe(true);
    expect(parseAuthConfig({ ...auth, OIDC_TRUST_EMAIL: " " }).OIDC_TRUST_EMAIL).toBe(false);
    expect(() => parseAuthConfig({ ...auth, OIDC_TRUST_EMAIL: "yes" })).toThrow(/OIDC_TRUST_EMAIL/);
  });
});

describe("parseDirectoryConfig", () => {
  it("is manual by default and needs the first admins, or nobody could ever get in", () => {
    expect(() => parseDirectoryConfig({})).toThrow(/INITIAL_ADMIN_EMAILS: is required with DIRECTORY=manual/);
    expect(() => parseDirectoryConfig({ INITIAL_ADMIN_EMAILS: " , " })).toThrow(/INITIAL_ADMIN_EMAILS/);
    expect(parseDirectoryConfig({ INITIAL_ADMIN_EMAILS: "Ada@Example.org, bob@example.org;carl@example.org" })).toEqual({
      DIRECTORY: "manual",
      INITIAL_ADMIN_EMAILS: ["ada@example.org", "bob@example.org", "carl@example.org"],
    });
    expect(() => parseDirectoryConfig({ INITIAL_ADMIN_EMAILS: "not-an-email" })).toThrow(/INITIAL_ADMIN_EMAILS/);
  });

  it("uses the login client for the Keycloak directory unless it has its own", () => {
    expect(parseDirectoryConfig(keycloakDirectory)).toMatchObject({
      DIRECTORY: "keycloak",
      KEYCLOAK_CLIENT_ID: "library",
      KEYCLOAK_CLIENT_SECRET: "secret",
      KEYCLOAK_ACCESS_GROUP: "/library",
    });
    expect(
      parseDirectoryConfig({ ...keycloakDirectory, KEYCLOAK_CLIENT_ID: "library-directory", KEYCLOAK_CLIENT_SECRET: "other" }),
    ).toMatchObject({ KEYCLOAK_CLIENT_ID: "library-directory", KEYCLOAK_CLIENT_SECRET: "other" });
  });

  it("requires a Keycloak realm URL and all three group paths", () => {
    expect(() => parseDirectoryConfig({ ...keycloakDirectory, OIDC_ISSUER: "https://accounts.example.org" })).toThrow(/realms/);
    for (const name of ["KEYCLOAK_ACCESS_GROUP", "KEYCLOAK_ADMIN_GROUP", "KEYCLOAK_TEAMS_GROUP"]) {
      expect(() => parseDirectoryConfig({ ...keycloakDirectory, [name]: "" }), name).toThrow(name);
    }
    expect(() => parseDirectoryConfig({ ...keycloakDirectory, KEYCLOAK_ACCESS_GROUP: "library" })).toThrow(/group path/);
    expect(() => parseDirectoryConfig({ ...keycloakDirectory, KEYCLOAK_TEAMS_GROUP: "/org/teams/" })).toThrow(/group path/);
    expect(parseDirectoryConfig({ ...keycloakDirectory, KEYCLOAK_TEAMS_GROUP: "/org/teams" })).toMatchObject({
      KEYCLOAK_TEAMS_GROUP: "/org/teams",
    });
  });

  it("rejects an unknown directory", () => {
    expect(() => parseDirectoryConfig({ DIRECTORY: "ldap" })).toThrow(/DIRECTORY/);
  });
});

describe("validateWebConfig", () => {
  it("reports every missing variable at once", () => {
    let error: unknown;
    try {
      validateWebConfig({});
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    for (const name of ["DATABASE_URL", "LIBRARY_BASE_URL", "BETTER_AUTH_SECRET", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "INITIAL_ADMIN_EMAILS", "STORAGE_DIR"]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain("KEYCLOAK");
    expect(message).toContain("- OIDC_ISSUER: is required");
    expect(message).not.toContain("received undefined");
  });

  it("passes with a complete configuration", () => {
    const storage = { STORAGE_DIR: "/data" };
    expect(() => validateWebConfig({ DATABASE_URL: "postgres://u:p@db:5432/library", ...auth, ...manualDirectory, ...storage })).not.toThrow();
    expect(() => validateWebConfig({ DATABASE_URL: "postgres://u:p@db:5432/library", ...auth, ...keycloakDirectory, ...storage })).not.toThrow();
  });
});

describe("parseNotificationConfig", () => {
  const base = { LIBRARY_BASE_URL: "https://library.example.org/" };

  it("sends for real in production and only logs elsewhere", () => {
    expect(parseNotificationConfig({ ...base, NODE_ENV: "production" }).NOTIFICATION_TRANSPORT).toBe("live");
    expect(parseNotificationConfig({ ...base, NODE_ENV: "development" }).NOTIFICATION_TRANSPORT).toBe("console");
    expect(parseNotificationConfig({ ...base, NODE_ENV: "production", NOTIFICATION_TRANSPORT: "console" }).NOTIFICATION_TRANSPORT).toBe("console");
  });

  it("treats Slack and email as optional, blank as unset", () => {
    const config = parseNotificationConfig({ ...base, SLACK_BOT_TOKEN: "", SMTP_URL: " ", MAILERSEND_API_TOKEN: " ", MAIL_FROM: "" });
    expect(config).toMatchObject({
      LIBRARY_BASE_URL: "https://library.example.org",
      SLACK_BOT_TOKEN: undefined,
      SMTP_URL: undefined,
      MAILERSEND_API_TOKEN: undefined,
      MAIL_FROM_NAME: "Meldgrove Library",
    });
  });

  it("takes a Slack channel ID, not a channel name", () => {
  });

  it("rejects a user token for Slack", () => {
    expect(() => parseNotificationConfig({ ...base, SLACK_BOT_TOKEN: "xoxp-123" })).toThrow(/SLACK_BOT_TOKEN/);
  });

  it("needs a sender for email, and one way to send it", () => {
    expect(parseNotificationConfig({ ...base, SMTP_URL: "smtps://user:pass@mail.example.org:465", MAIL_FROM: "library@example.org" }).SMTP_URL).toBe(
      "smtps://user:pass@mail.example.org:465",
    );
    expect(() => parseNotificationConfig({ ...base, SMTP_URL: "smtp://mail.example.org" })).toThrow(/MAIL_FROM/);
    expect(() => parseNotificationConfig({ ...base, MAILERSEND_API_TOKEN: "mlsn.abc" })).toThrow(/MAIL_FROM/);
    expect(() => parseNotificationConfig({ ...base, MAILERSEND_API_TOKEN: "mlsn.abc", MAIL_FROM: "not-an-email" })).toThrow(/MAIL_FROM/);
    expect(() => parseNotificationConfig({ ...base, SMTP_URL: "https://mail.example.org", MAIL_FROM: "library@example.org" })).toThrow(/SMTP_URL/);
    expect(() =>
      parseNotificationConfig({ ...base, SMTP_URL: "smtp://mail.example.org", MAILERSEND_API_TOKEN: "mlsn.abc", MAIL_FROM: "library@example.org" }),
    ).toThrow(/either SMTP_URL or MAILERSEND_API_TOKEN/);
  });
});

describe("validateWorkerConfig", () => {
  it("needs the base URL for links in messages", () => {
    const rest = { DATABASE_URL: "postgres://u:p@db:5432/library", STORAGE_DIR: "/data", NODE_ENV: "test", ...manualDirectory };
    expect(() => validateWorkerConfig(rest)).toThrow(/LIBRARY_BASE_URL/);
    expect(() => validateWorkerConfig({ ...rest, LIBRARY_BASE_URL: "https://library.example.org" })).not.toThrow();
    expect(() => validateWorkerConfig({ ...rest, LIBRARY_BASE_URL: "https://library.example.org", NODE_ENV: "production" })).toThrow(/AI_PROVIDER/);
  });
});

describe("parseStorageConfig", () => {
  it("keeps originals in a directory by default", () => {
    expect(parseStorageConfig({ STORAGE_DIR: "/data" })).toEqual({ STORAGE_DRIVER: "filesystem", STORAGE_DIR: "/data" });
    expect(() => parseStorageConfig({})).toThrow(/STORAGE_DIR/);
    expect(() => parseStorageConfig({ STORAGE_DIR: ".storage", NODE_ENV: "production" })).toThrow(/absolute path/);
  });

  it("needs the bucket and its credentials for S3", () => {
    expect(() => parseStorageConfig({ STORAGE_DRIVER: "s3", S3_REGION: "fsn1" })).toThrow(/S3_BUCKET[\s\S]*S3_ACCESS_KEY_ID/);
    const config = parseStorageConfig({
      STORAGE_DRIVER: "s3",
      S3_ENDPOINT: "https://fsn1.your-objectstorage.com",
      S3_REGION: "fsn1",
      S3_BUCKET: "library",
      S3_ACCESS_KEY_ID: "id",
      S3_SECRET_ACCESS_KEY: "secret",
    });
    expect(config).toMatchObject({ STORAGE_DRIVER: "s3", S3_BUCKET: "library", S3_FORCE_PATH_STYLE: false });
  });
});

describe("parseUploadConfig", () => {
  it("allows 50 MB by default and takes a whole number", () => {
    expect(parseUploadConfig({}).UPLOAD_MAX_MB).toBe(50);
    expect(parseUploadConfig({ UPLOAD_MAX_MB: "20" }).UPLOAD_MAX_MB).toBe(20);
    expect(() => parseUploadConfig({ UPLOAD_MAX_MB: "big" })).toThrow(/UPLOAD_MAX_MB/);
  });
});

describe("parseAiConfig", () => {
  it("uses the fake model outside production, and needs a real one in production", () => {
    expect(parseAiConfig({ NODE_ENV: "test" })).toEqual({ AI_PROVIDER: "fake", AI_DAILY_LIMIT: 200 });
    expect(() => parseAiConfig({ NODE_ENV: "production" })).toThrow(/AI_PROVIDER/);
  });

  it("needs the URL, key, and model of an OpenAI-compatible API", () => {
    expect(() => parseAiConfig({ AI_PROVIDER: "openai-compatible" })).toThrow(/AI_BASE_URL[\s\S]*AI_API_KEY[\s\S]*AI_MODEL/);
    const config = parseAiConfig({
      AI_PROVIDER: "openai-compatible",
      AI_BASE_URL: "https://api.mistral.ai/v1/",
      AI_API_KEY: "key",
      AI_MODEL: "mistral-medium-latest",
    });
    expect(config).toMatchObject({ AI_BASE_URL: "https://api.mistral.ai/v1", AI_DAILY_LIMIT: 200, AI_TIMEOUT_MS: 120_000 });
  });
});

describe("parseWebhookConfig", () => {
  it("is off without a URL", () => {
    expect(parseWebhookConfig({})).toEqual({ WEBHOOK_URL: undefined, WEBHOOK_SECRET: undefined });
    expect(parseWebhookConfig({ WEBHOOK_URL: "https://hooks.example.org/library", WEBHOOK_SECRET: "a-long-enough-secret" })).toMatchObject({
      WEBHOOK_URL: "https://hooks.example.org/library",
    });
  });

  it("needs a signing secret of at least 16 characters with a URL", () => {
    expect(() => parseWebhookConfig({ WEBHOOK_URL: "https://hooks.example.org/library" })).toThrow(/WEBHOOK_SECRET: is required with WEBHOOK_URL/);
    expect(() => parseWebhookConfig({ WEBHOOK_URL: "https://hooks.example.org/library", WEBHOOK_SECRET: "short" })).toThrow(/WEBHOOK_SECRET/);
  });
});

describe("parseOcrConfig", () => {
  it("is off without a command and checks the language codes", () => {
    expect(parseOcrConfig({})).toEqual({ OCR_COMMAND: undefined, OCR_LANGUAGES: "deu+eng" });
    expect(() => parseOcrConfig({ OCR_LANGUAGES: "German" })).toThrow(/OCR_LANGUAGES/);
  });
});

describe("parseVersionConfig", () => {
  it("has no version in images built from source", () => {
    expect(parseVersionConfig({ APP_VERSION: "" }).APP_VERSION).toBeUndefined();
    expect(parseVersionConfig({ APP_VERSION: "0.2.0" }).APP_VERSION).toBe("0.2.0");
  });
});

describe("parseErrorReportingConfig", () => {
  it("is off without a DSN and rejects a DSN that is not a URL", () => {
    expect(parseErrorReportingConfig({ SENTRY_DSN: " " }).SENTRY_DSN).toBeUndefined();
    expect(parseErrorReportingConfig({ SENTRY_DSN: "https://key@o1.ingest.example.org/2" }).SENTRY_DSN).toBe(
      "https://key@o1.ingest.example.org/2",
    );
    expect(() => parseErrorReportingConfig({ SENTRY_DSN: "key@o1" })).toThrow(/SENTRY_DSN/);
    expect(() => validateWorkerConfig({ SENTRY_DSN: "key@o1" })).toThrow(/SENTRY_DSN/);
  });
});

describe("parseSlackIntakeConfig", () => {
  it("is off without a signing secret", () => {
    expect(parseSlackIntakeConfig({ SLACK_SIGNING_SECRET: " " }).SLACK_SIGNING_SECRET).toBeUndefined();
    expect(parseSlackIntakeConfig({ SLACK_SIGNING_SECRET: "8f742231b10e8888abcd99yyyzzz85a5" }).SLACK_SIGNING_SECRET).toBe("8f742231b10e8888abcd99yyyzzz85a5");
  });
});

describe("parseDigestConfig", () => {
  it("takes a Slack channel ID, not a channel name or a direct message", () => {
    expect(parseDigestConfig({}).DIGEST_SLACK_CHANNEL_ID).toBeUndefined();
    expect(parseDigestConfig({ DIGEST_SLACK_CHANNEL_ID: "C0123456789" }).DIGEST_SLACK_CHANNEL_ID).toBe("C0123456789");
    expect(() => parseDigestConfig({ DIGEST_SLACK_CHANNEL_ID: "#library" })).toThrow(/DIGEST_SLACK_CHANNEL_ID/);
    expect(() => parseDigestConfig({ DIGEST_SLACK_CHANNEL_ID: "D0123456789" })).toThrow(/DIGEST_SLACK_CHANNEL_ID/);
    expect(() => validateWorkerConfig({ DIGEST_SLACK_CHANNEL_ID: "library" })).toThrow(/DIGEST_SLACK_CHANNEL_ID/);
  });

  it("takes one email address for the newsletter", () => {
    expect(parseDigestConfig({ DIGEST_EMAIL_TO: "All-Staff@Example.org" }).DIGEST_EMAIL_TO).toBe("all-staff@example.org");
    expect(() => parseDigestConfig({ DIGEST_EMAIL_TO: "all staff" })).toThrow(/DIGEST_EMAIL_TO/);
  });
});

describe("parseEmailIntakeConfig", () => {
  it("is off without a URL and reads INBOX by default", () => {
    expect(parseEmailIntakeConfig({})).toEqual({
      EMAIL_INTAKE_IMAP_URL: undefined,
      EMAIL_INTAKE_MAILBOX: "INBOX",
      EMAIL_INTAKE_DOMAINS: [],
      EMAIL_INTAKE_DONE_MAILBOX: undefined,
    });
  });

  it("needs credentials in the URL and the allowed sender domains", () => {
    const url = "imaps://library%40example.org:p%40ss@imap.example.org:993";
    expect(parseEmailIntakeConfig({ EMAIL_INTAKE_IMAP_URL: url, EMAIL_INTAKE_DOMAINS: "Example.org, @staff.example.org" }).EMAIL_INTAKE_DOMAINS).toEqual([
      "example.org",
      "staff.example.org",
    ]);
    expect(() => parseEmailIntakeConfig({ EMAIL_INTAKE_IMAP_URL: url })).toThrow(/EMAIL_INTAKE_DOMAINS: is required/);
    expect(() => parseEmailIntakeConfig({ EMAIL_INTAKE_IMAP_URL: "imaps://imap.example.org", EMAIL_INTAKE_DOMAINS: "example.org" })).toThrow(/user and password/);
    expect(() => parseEmailIntakeConfig({ EMAIL_INTAKE_IMAP_URL: "https://imap.example.org", EMAIL_INTAKE_DOMAINS: "example.org" })).toThrow(/imaps/);
    expect(() => parseEmailIntakeConfig({ EMAIL_INTAKE_DOMAINS: "not a domain" })).toThrow(/EMAIL_INTAKE_DOMAINS/);
  });
});
