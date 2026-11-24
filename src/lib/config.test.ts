import { describe, expect, it } from "vitest";
import {
  ConfigError,
  parseAuthConfig,
  parseDirectoryConfig,
  parseErrorReportingConfig,
  parseVersionConfig,
  parseNotificationConfig,
  parseAiLimitsConfig,
  parseOcrConfig,
  parseSettingsSecretConfig,
  parseStorageConfig,
  parseUploadConfig,
  parseUpdaterConfig,
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
});

describe("validateWorkerConfig", () => {
  it("needs the base URL for links in messages", () => {
    const rest = { DATABASE_URL: "postgres://u:p@db:5432/library", STORAGE_DIR: "/data", NODE_ENV: "test", ...manualDirectory };
    expect(() => validateWorkerConfig(rest)).toThrow(/LIBRARY_BASE_URL/);
    expect(() => validateWorkerConfig({ ...rest, LIBRARY_BASE_URL: "https://library.example.org" })).not.toThrow();
  });

  it("starts in production without an AI model, and with the AI_PROVIDER that a Compose file up to 0.3.4 passes", () => {
    const production = { DATABASE_URL: "postgres://u:p@db:5432/library", STORAGE_DIR: "/data", NODE_ENV: "production", LIBRARY_BASE_URL: "https://library.example.org", ...manualDirectory };
    expect(() => validateWorkerConfig(production)).not.toThrow();
    expect(() => validateWorkerConfig({ ...production, AI_PROVIDER: "openai-compatible" })).not.toThrow();
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

  it("is off with S3 and none of its variables, as compose.yaml starts without them", () => {
    const blank = { S3_ENDPOINT: "", S3_REGION: "", S3_BUCKET: "", S3_ACCESS_KEY_ID: "", S3_SECRET_ACCESS_KEY: "", S3_FORCE_PATH_STYLE: "" };
    expect(parseStorageConfig({ STORAGE_DRIVER: "s3", ...blank, STORAGE_DIR: "/data/originals" })).toEqual({ STORAGE_DRIVER: "off" });
    expect(parseStorageConfig({ STORAGE_DRIVER: "off" })).toEqual({ STORAGE_DRIVER: "off" });
    expect(() => parseStorageConfig({ STORAGE_DRIVER: "s3", ...blank, S3_BUCKET: "library" })).toThrow(/S3_REGION/);
    expect(() =>
      validateWebConfig({ DATABASE_URL: "postgres://u:p@db:5432/library", ...auth, ...manualDirectory, STORAGE_DRIVER: "s3", ...blank }),
    ).not.toThrow();
  });
});

describe("parseUploadConfig", () => {
  it("allows 50 MB by default and takes a whole number", () => {
    expect(parseUploadConfig({}).UPLOAD_MAX_MB).toBe(50);
    expect(parseUploadConfig({ UPLOAD_MAX_MB: "20" }).UPLOAD_MAX_MB).toBe(20);
    expect(() => parseUploadConfig({ UPLOAD_MAX_MB: "big" })).toThrow(/UPLOAD_MAX_MB/);
  });
});

describe("parseAiLimitsConfig", () => {
  it("limits drafts per day and their time, and switches on the fake model only with AI_PROVIDER=fake", () => {
    expect(parseAiLimitsConfig({})).toEqual({ AI_DAILY_LIMIT: 200, AI_TIMEOUT_MS: 120_000, AI_FAKE: false });
    expect(parseAiLimitsConfig({ AI_PROVIDER: "fake", AI_DAILY_LIMIT: "5" })).toMatchObject({ AI_DAILY_LIMIT: 5, AI_FAKE: true });
    expect(parseAiLimitsConfig({ AI_PROVIDER: "anthropic" }).AI_FAKE).toBe(false);
    expect(() => parseAiLimitsConfig({ AI_TIMEOUT_MS: "soon" })).toThrow(/AI_TIMEOUT_MS/);
  });
});

describe("parseSettingsSecretConfig", () => {
  it("is optional, so a worker started with an older Compose file still starts", () => {
    expect(parseSettingsSecretConfig({}).BETTER_AUTH_SECRET).toBeUndefined();
    expect(parseSettingsSecretConfig({ BETTER_AUTH_SECRET: "x".repeat(32) }).BETTER_AUTH_SECRET).toBe("x".repeat(32));
    expect(() => parseSettingsSecretConfig({ BETTER_AUTH_SECRET: "short" })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => parseSettingsSecretConfig({ BETTER_AUTH_SECRET: "development-secret-development-secret", NODE_ENV: "production" })).toThrow(/example value/);
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

describe("parseUpdaterConfig", () => {
  it("asks the updater service of compose.yaml unless UPDATER_URL says otherwise", () => {
    expect(parseUpdaterConfig({}).UPDATER_URL).toBe("http://updater:8080");
    expect(parseUpdaterConfig({ UPDATER_URL: "http://127.0.0.1:8080/" }).UPDATER_URL).toBe("http://127.0.0.1:8080");
  });

  it("switches the update button off when UPDATER_URL is empty", () => {
    expect(parseUpdaterConfig({ UPDATER_URL: "" }).UPDATER_URL).toBeNull();
    expect(parseUpdaterConfig({ UPDATER_URL: "  " }).UPDATER_URL).toBeNull();
  });

  it("refuses anything but a web address", () => {
    expect(() => parseUpdaterConfig({ UPDATER_URL: "updater:8080" })).toThrow(/UPDATER_URL: must be a URL/);
    expect(() => validateWebConfig({ UPDATER_URL: "ftp://updater" })).toThrow(/UPDATER_URL/);
  });

  it("sends no token unless UPDATER_TOKEN is set, and refuses one with spaces", () => {
    expect(parseUpdaterConfig({}).UPDATER_TOKEN).toBeUndefined();
    expect(parseUpdaterConfig({ UPDATER_TOKEN: " " }).UPDATER_TOKEN).toBeUndefined();
    expect(parseUpdaterConfig({ UPDATER_TOKEN: "0123456789abcdef" }).UPDATER_TOKEN).toBe("0123456789abcdef");
    expect(() => parseUpdaterConfig({ UPDATER_TOKEN: "two words" })).toThrow(/UPDATER_TOKEN: must be visible ASCII/);
  });
});
