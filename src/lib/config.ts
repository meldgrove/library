import { z } from "zod";

/**
 * Environment configuration, validated with zod: only what a process needs
 * before it can read the database, and limits that admins must not change.
 * Outside services (Slack, email, the AI provider, the webhook, the intake
 * mailbox) are set on the admin page or with `cli settings`
 * (`src/lib/settings/`).
 *
 * Each process validates only what it needs: `migrate` needs the database,
 * the worker also needs the directory and storage, and the web process
 * needs the database, login, the directory, and storage. Empty strings
 * count as unset, because some platforms pass unset variables as "".
 */

type Env = Record<string, string | undefined>;

const blankAsUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/** A variable that must be set; when it is not, the error says so instead of naming types. */
export const required = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankAsUndefined, z.any().refine((value) => value !== undefined, { message: "is required", abort: true }).pipe(schema));
export const requiredString = () => required(z.string().min(1));
export const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankAsUndefined, schema.optional());

export const httpUrl = z.url({ protocol: /^https?$/ });
export const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, "");

/** A positive whole number; unset means `fallback`. */
export const positiveInt = (fallback: number) =>
  z.preprocess((value) => blankAsUndefined(value) ?? String(fallback), z.coerce.number().int().positive());

/** The value of BETTER_AUTH_SECRET in `.env.example`, refused in production. */
export const EXAMPLE_SECRET = "development-secret-development-secret";

/** A Keycloak group path such as "/library" or "/staff/library". */
const groupPath = z.string().regex(/^\/[^/].*[^/]$|^\/[^/]$/, 'must be a group path such as "/library"');

/** A list of email addresses, separated by commas, semicolons, or spaces. Lower-cased. */
const emailList = z.preprocess(
  (value) =>
    typeof value === "string"
      ? value
          .split(/[\s,;]+/)
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean)
      : [],
  z.array(z.email()),
);

/** "true" or "false"; unset means `fallback`. */
const flag = (fallback: boolean) =>
  z.preprocess(blankAsUndefined, z.enum(["true", "false"], { error: 'must be "true" or "false"' }).optional()).transform((value) =>
    value === undefined ? fallback : value === "true",
  );

const S3_VARIABLES = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_FORCE_PATH_STYLE"];

/**
 * Fills in defaults for unset or blank variables. The Keycloak directory uses
 * the login client unless it has its own.
 */
function withDefaults(env: Env): Env {
  const value = (name: string) => blankAsUndefined(env[name]) as string | undefined;
  const storageDriver = value("STORAGE_DRIVER") ?? "filesystem";
  return {
    ...env,
    DIRECTORY: value("DIRECTORY") ?? "manual",
    OIDC_SCOPES: value("OIDC_SCOPES") ?? "openid profile email",
    KEYCLOAK_CLIENT_ID: value("KEYCLOAK_CLIENT_ID") ?? value("OIDC_CLIENT_ID"),
    KEYCLOAK_CLIENT_SECRET: value("KEYCLOAK_CLIENT_SECRET") ?? value("OIDC_CLIENT_SECRET"),
    // Production sends for real; development and tests only log.
    NOTIFICATION_TRANSPORT: value("NOTIFICATION_TRANSPORT") ?? (env.NODE_ENV === "production" ? "live" : "console"),
    // S3 without any of its settings is no storage: the library takes links only.
    STORAGE_DRIVER: storageDriver === "s3" && S3_VARIABLES.every((name) => value(name) === undefined) ? "off" : storageDriver,
    OCR_LANGUAGES: value("OCR_LANGUAGES") ?? "deu+eng",
  };
}

const databaseSchema = z.object({
  DATABASE_URL: required(z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL")),
});

const authSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    LIBRARY_BASE_URL: required(httpUrl.transform(withoutTrailingSlash)),
    BETTER_AUTH_SECRET: required(z.string().min(32, "must be at least 32 characters")),
    OIDC_ISSUER: required(httpUrl.transform(withoutTrailingSlash)),
    OIDC_CLIENT_ID: requiredString(),
    OIDC_CLIENT_SECRET: requiredString(),
    OIDC_SCOPES: requiredString(),
    /**
     * Treat every email address from the provider as verified. Only for
     * providers that do not send `email_verified` (e.g. Microsoft Entra ID)
     * and whose users cannot choose their own address.
     */
    OIDC_TRUST_EMAIL: flag(false),
    /** Shown on the sign-in button, e.g. "Microsoft" for "Sign in with Microsoft". */
    OIDC_PROVIDER_NAME: optional(z.string().trim().max(40, "must be at most 40 characters")),
  })
  .refine((env) => env.NODE_ENV !== "production" || env.BETTER_AUTH_SECRET !== EXAMPLE_SECRET, {
    message: "is the example value from .env.example; generate one with `openssl rand -base64 32`",
    path: ["BETTER_AUTH_SECRET"],
  })
  .transform(({ NODE_ENV: _, ...config }) => config);

/**
 * Where people, teams, and access come from:
 *
 * - `manual`: admins invite people and manage teams in the library. While there
 *   is no admin, the first login with an address in INITIAL_ADMIN_EMAILS
 *   becomes one; without that list nobody could ever get in.
 * - `keycloak`: a sync reads the members of Keycloak groups through the
 *   Keycloak Admin API. Every entry belongs to a team, and teams, tags, and
 *   stuck proposals need admins, so all three groups are required.
 */
const directorySchema = z.discriminatedUnion("DIRECTORY", [
  z.object({
    DIRECTORY: z.literal("manual"),
    INITIAL_ADMIN_EMAILS: emailList.refine((emails) => emails.length > 0, {
      message: "is required with DIRECTORY=manual: list the email addresses of the first admins",
    }),
  }),
  z.object({
    DIRECTORY: z.literal("keycloak"),
    OIDC_ISSUER: required(
      httpUrl
        .transform(withoutTrailingSlash)
        .refine((url) => /\/realms\/[^/]+$/.test(url), "must be a Keycloak realm URL ending in /realms/<realm>"),
    ),
    KEYCLOAK_CLIENT_ID: requiredString(),
    KEYCLOAK_CLIENT_SECRET: requiredString(),
    KEYCLOAK_ACCESS_GROUP: required(groupPath),
    KEYCLOAK_ADMIN_GROUP: required(groupPath),
    KEYCLOAK_MAINTAINER_GROUP: optional(groupPath),
    KEYCLOAK_TEAMS_GROUP: required(groupPath),
  }),
]);

/**
 * How notifications go out: for real, or only to the log (development and
 * tests). Slack and email themselves are settings in the database.
 */
const notificationSchema = z.object({
  NOTIFICATION_TRANSPORT: z.enum(["live", "console"]),
  LIBRARY_BASE_URL: required(httpUrl.transform(withoutTrailingSlash)),
});

/**
 * Where originals are kept: a directory (development, tests, single-server
 * setups) or an S3-compatible bucket (Hetzner Object Storage, MinIO). Off,
 * the library refuses files and keeps only the text of links.
 */
const storageSchema = z.discriminatedUnion("STORAGE_DRIVER", [
  z.object({
    STORAGE_DRIVER: z.literal("filesystem"),
    NODE_ENV: z.string().optional(),
    STORAGE_DIR: requiredString(),
  })
    // The standalone server changes its working directory, so web and worker
    // would resolve a relative path to different places.
    .refine((env) => env.NODE_ENV !== "production" || env.STORAGE_DIR.startsWith("/"), {
      message: "must be an absolute path in production",
      path: ["STORAGE_DIR"],
    })
    .transform(({ NODE_ENV: _, ...config }) => config),
  z.object({
    STORAGE_DRIVER: z.literal("s3"),
    S3_ENDPOINT: optional(httpUrl),
    S3_REGION: requiredString(),
    S3_BUCKET: requiredString(),
    S3_ACCESS_KEY_ID: requiredString(),
    S3_SECRET_ACCESS_KEY: requiredString(),
    /** Path-style URLs (bucket in the path), needed by MinIO. */
    S3_FORCE_PATH_STYLE: flag(false),
  }),
  z.object({ STORAGE_DRIVER: z.literal("off") }),
]);

/** What staff may upload. */
const uploadSchema = z.object({
  /** Largest original file, in megabytes. */
  UPLOAD_MAX_MB: positiveInt(50),
});

/**
 * Limits on the AI model, which admins set up in the library. AI_PROVIDER
 * here only switches on `fake`, which drafts from the text without a model
 * (development and tests); other values have no effect.
 */
const aiLimitsSchema = z
  .object({
    AI_PROVIDER: optional(z.string()),
    /** Drafts per day, across all uploads; the rest waits for the next day. */
    AI_DAILY_LIMIT: positiveInt(200),
    AI_TIMEOUT_MS: positiveInt(120_000),
  })
  .transform(({ AI_PROVIDER, ...limits }) => ({ ...limits, AI_FAKE: AI_PROVIDER === "fake" }));

/**
 * The root key of the settings in the database: their secrets are sealed
 * with a key derived from BETTER_AUTH_SECRET (`src/lib/settings/secret-box.ts`).
 * The web process requires it (`authSchema`); Compose files up to 0.3.2 do
 * not pass it to the worker, which then cannot read the secrets.
 */
const settingsSecretSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    BETTER_AUTH_SECRET: optional(z.string().min(32, "must be at least 32 characters")),
  })
  .refine((env) => env.NODE_ENV !== "production" || env.BETTER_AUTH_SECRET !== EXAMPLE_SECRET, {
    message: "is the example value from .env.example; generate one with `openssl rand -base64 32`",
    path: ["BETTER_AUTH_SECRET"],
  })
  .transform(({ BETTER_AUTH_SECRET }) => ({ BETTER_AUTH_SECRET }));

/** Text recognition for scanned PDFs: a command such as `ocrmypdf`; off when unset. */
const ocrSchema = z.object({
  OCR_COMMAND: optional(z.string().min(1)),
  OCR_LANGUAGES: required(z.string().regex(/^[a-z_]+(\+[a-z_]+)*$/, 'must be Tesseract language codes such as "deu+eng"')),
});

/** The release version, e.g. "0.2.0". Release images set it; images built from source have none. */
const versionSchema = z.object({
  APP_VERSION: optional(z.string()),
});

/** Error reporting to Sentry: off until SENTRY_DSN is set. Without SENTRY_RELEASE, the release is named after APP_VERSION. */
const errorReportingSchema = z.object({
  ...versionSchema.shape,
  SENTRY_DSN: optional(httpUrl),
  SENTRY_ENVIRONMENT: optional(z.string()),
  SENTRY_RELEASE: optional(z.string()),
});

/** The update service: the `updater` service of compose.yaml, unless UPDATER_URL says otherwise. */
export const DEFAULT_UPDATER_URL = "http://updater:8080";

/**
 * The update button asks the Meldgrove Updater at UPDATER_URL. Unset means
 * DEFAULT_UPDATER_URL. Unlike other variables, an empty value is not unset:
 * it switches the update button off (`null`).
 */
const updaterSchema = z.object({
  UPDATER_URL: z
    .preprocess(
      (value) => (value === undefined ? DEFAULT_UPDATER_URL : typeof value === "string" ? value.trim() : value),
      z.string().refine((value) => value === "" || httpUrl.safeParse(value).success, "must be a URL such as http://updater:8080, or empty to switch the update button off"),
    )
    .transform((value) => (value === "" ? null : withoutTrailingSlash(value))),
  /**
   * Sent to the updater with each request (`Authorization: Bearer`); the
   * updater's API_TOKEN, the same value in compose.yaml, then refuses requests
   * without it. Unset: no token, and the updater takes any request.
   */
  UPDATER_TOKEN: optional(z.string().regex(/^[\x21-\x7e]+$/, "must be visible ASCII characters without spaces, such as the output of openssl rand -hex 32")),
});

export type DatabaseConfig = z.infer<typeof databaseSchema>;
export type AuthConfig = z.infer<typeof authSchema>;
export type DirectoryConfig = z.infer<typeof directorySchema>;
export type KeycloakDirectoryConfig = Extract<DirectoryConfig, { DIRECTORY: "keycloak" }>;
export type NotificationConfig = z.infer<typeof notificationSchema>;
export type StorageConfig = z.infer<typeof storageSchema>;
export type UploadConfig = z.infer<typeof uploadSchema>;
export type AiLimitsConfig = z.infer<typeof aiLimitsSchema>;
export type SettingsSecretConfig = z.infer<typeof settingsSecretSchema>;
export type OcrConfig = z.infer<typeof ocrSchema>;
export type VersionConfig = z.infer<typeof versionSchema>;
export type ErrorReportingConfig = z.infer<typeof errorReportingSchema>;
export type UpdaterConfig = z.infer<typeof updaterSchema>;

export class ConfigError extends Error {
  constructor(issues: z.core.$ZodIssue[]) {
    const lines = issues.map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    super(`Invalid environment configuration:\n${lines.join("\n")}`);
    this.name = "ConfigError";
  }
}

function parse<T extends z.ZodType>(schema: T, env: Env): z.infer<T> {
  const result = schema.safeParse(withDefaults(env));
  if (!result.success) throw new ConfigError(result.error.issues);
  return result.data;
}

export function parseDatabaseConfig(env: Env = process.env): DatabaseConfig {
  return parse(databaseSchema, env);
}

export function parseAuthConfig(env: Env = process.env): AuthConfig {
  return parse(authSchema, env);
}

export function parseDirectoryConfig(env: Env = process.env): DirectoryConfig {
  return parse(directorySchema, env);
}

export function parseNotificationConfig(env: Env = process.env): NotificationConfig {
  return parse(notificationSchema, env);
}

export function parseStorageConfig(env: Env = process.env): StorageConfig {
  return parse(storageSchema, env);
}

export function parseUploadConfig(env: Env = process.env): UploadConfig {
  return parse(uploadSchema, env);
}

export function parseAiLimitsConfig(env: Env = process.env): AiLimitsConfig {
  return parse(aiLimitsSchema, env);
}

export function parseSettingsSecretConfig(env: Env = process.env): SettingsSecretConfig {
  return parse(settingsSecretSchema, env);
}

export function parseOcrConfig(env: Env = process.env): OcrConfig {
  return parse(ocrSchema, env);
}

export function parseVersionConfig(env: Env = process.env): VersionConfig {
  return parse(versionSchema, env);
}

export function parseErrorReportingConfig(env: Env = process.env): ErrorReportingConfig {
  return parse(errorReportingSchema, env);
}

export function parseUpdaterConfig(env: Env = process.env): UpdaterConfig {
  return parse(updaterSchema, env);
}

function validate(schemas: readonly z.ZodType[], env: Env): void {
  const issues: z.core.$ZodIssue[] = [];
  const withDefaultValues = withDefaults(env);
  for (const schema of schemas) {
    const result = schema.safeParse(withDefaultValues);
    if (!result.success) issues.push(...result.error.issues);
  }
  if (issues.length > 0) throw new ConfigError(issues);
}

/** Validates every variable the web process needs. Called once at startup. */
export function validateWebConfig(env: Env = process.env): void {
  validate([databaseSchema, authSchema, directorySchema, storageSchema, uploadSchema, errorReportingSchema, updaterSchema], env);
}

/** Validates every variable the worker needs. */
export function validateWorkerConfig(env: Env = process.env): void {
  validate(
    [
      databaseSchema,
      directorySchema,
      notificationSchema,
      storageSchema,
      uploadSchema,
      aiLimitsSchema,
      settingsSecretSchema,
      ocrSchema,
      errorReportingSchema,
    ],
    env,
  );
}

let databaseConfig: DatabaseConfig | undefined;
let authConfig: AuthConfig | undefined;
let directoryConfig: DirectoryConfig | undefined;
let notificationConfig: NotificationConfig | undefined;
let storageConfig: StorageConfig | undefined;
let uploadConfig: UploadConfig | undefined;
let aiLimitsConfig: AiLimitsConfig | undefined;
let settingsSecretConfig: SettingsSecretConfig | undefined;
let ocrConfig: OcrConfig | undefined;
let versionConfig: VersionConfig | undefined;
let errorReportingConfig: ErrorReportingConfig | undefined;
let updaterConfig: UpdaterConfig | undefined;

export function getDatabaseConfig(): DatabaseConfig {
  databaseConfig ??= parseDatabaseConfig();
  return databaseConfig;
}

export function getAuthConfig(): AuthConfig {
  authConfig ??= parseAuthConfig();
  return authConfig;
}

export function getDirectoryConfig(): DirectoryConfig {
  directoryConfig ??= parseDirectoryConfig();
  return directoryConfig;
}

export function getNotificationConfig(): NotificationConfig {
  notificationConfig ??= parseNotificationConfig();
  return notificationConfig;
}

export function getStorageConfig(): StorageConfig {
  storageConfig ??= parseStorageConfig();
  return storageConfig;
}

export function getUploadConfig(): UploadConfig {
  uploadConfig ??= parseUploadConfig();
  return uploadConfig;
}

export function getSettingsSecretConfig(): SettingsSecretConfig {
  settingsSecretConfig ??= parseSettingsSecretConfig();
  return settingsSecretConfig;
}

export function getAiLimitsConfig(): AiLimitsConfig {
  aiLimitsConfig ??= parseAiLimitsConfig();
  return aiLimitsConfig;
}

export function getOcrConfig(): OcrConfig {
  ocrConfig ??= parseOcrConfig();
  return ocrConfig;
}

export function getVersionConfig(): VersionConfig {
  versionConfig ??= parseVersionConfig();
  return versionConfig;
}

export function getErrorReportingConfig(): ErrorReportingConfig {
  errorReportingConfig ??= parseErrorReportingConfig();
  return errorReportingConfig;
}

export function getUpdaterConfig(): UpdaterConfig {
  updaterConfig ??= parseUpdaterConfig();
  return updaterConfig;
}
