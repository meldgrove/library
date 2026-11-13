import { z } from "zod";
import { SLACK_CHANNEL_ID_PATTERN } from "@/lib/library/constants";

/**
 * Environment configuration, validated with zod.
 *
 * Each process validates only what it needs: `migrate` needs the database,
 * the worker also needs the directory, notifications, storage, and the AI
 * model, and the web process needs the database, login, the directory, and
 * storage. Empty strings
 * count as unset, because some platforms pass unset variables as "".
 */

type Env = Record<string, string | undefined>;

const blankAsUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/** A variable that must be set; when it is not, the error says so instead of naming types. */
const required = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankAsUndefined, z.any().refine((value) => value !== undefined, { message: "is required", abort: true }).pipe(schema));
const requiredString = () => required(z.string().min(1));
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankAsUndefined, schema.optional());

const httpUrl = z.url({ protocol: /^https?$/ });
const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, "");

/** A positive whole number; unset means `fallback`. */
const positiveInt = (fallback: number) =>
  z.preprocess((value) => blankAsUndefined(value) ?? String(fallback), z.coerce.number().int().positive());

/** The value of BETTER_AUTH_SECRET in `.env.example`, refused in production. */
const EXAMPLE_SECRET = "development-secret-development-secret";

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

/**
 * Fills in defaults for unset or blank variables. The Keycloak directory uses
 * the login client unless it has its own.
 */
function withDefaults(env: Env): Env {
  const value = (name: string) => blankAsUndefined(env[name]) as string | undefined;
  return {
    ...env,
    DIRECTORY: value("DIRECTORY") ?? "manual",
    OIDC_SCOPES: value("OIDC_SCOPES") ?? "openid profile email",
    KEYCLOAK_CLIENT_ID: value("KEYCLOAK_CLIENT_ID") ?? value("OIDC_CLIENT_ID"),
    KEYCLOAK_CLIENT_SECRET: value("KEYCLOAK_CLIENT_SECRET") ?? value("OIDC_CLIENT_SECRET"),
    // Production sends for real; development and tests only log.
    NOTIFICATION_TRANSPORT: value("NOTIFICATION_TRANSPORT") ?? (env.NODE_ENV === "production" ? "live" : "console"),
    MAIL_FROM_NAME: value("MAIL_FROM_NAME") ?? "Meldgrove Library",
    STORAGE_DRIVER: value("STORAGE_DRIVER") ?? "filesystem",
    // The fake model only exists outside production.
    AI_PROVIDER: value("AI_PROVIDER") ?? (env.NODE_ENV === "production" ? undefined : "fake"),
    OCR_LANGUAGES: value("OCR_LANGUAGES") ?? "deu+eng",
    EMAIL_INTAKE_MAILBOX: value("EMAIL_INTAKE_MAILBOX") ?? "INBOX",
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
    KEYCLOAK_TEAMS_GROUP: required(groupPath),
  }),
]);

/**
 * Notifications. Slack and email are each optional: a channel without its
 * settings is off. Email goes through SMTP or MailerSend.
 */
const notificationSchema = z
  .object({
    NOTIFICATION_TRANSPORT: z.enum(["live", "console"]),
    LIBRARY_BASE_URL: required(httpUrl.transform(withoutTrailingSlash)),
    SLACK_BOT_TOKEN: optional(z.string().startsWith("xoxb-", "must be a Slack bot token (xoxb-…)")),
    SMTP_URL: optional(z.url({ protocol: /^smtps?$/, error: "must be an smtp:// or smtps:// URL" })),
    MAILERSEND_API_TOKEN: optional(z.string().min(1)),
    MAIL_FROM: optional(z.email()),
    MAIL_FROM_NAME: requiredString(),
  })
  .refine((env) => !(env.SMTP_URL && env.MAILERSEND_API_TOKEN), {
    message: "set either SMTP_URL or MAILERSEND_API_TOKEN, not both",
    path: ["MAILERSEND_API_TOKEN"],
  })
  .refine((env) => !(env.SMTP_URL || env.MAILERSEND_API_TOKEN) || env.MAIL_FROM, {
    message: "is required to send email",
    path: ["MAIL_FROM"],
  });

/**
 * Where originals are kept: a directory (development, tests, single-server
 * setups) or an S3-compatible bucket (Hetzner Object Storage, MinIO).
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
]);

/** What staff may upload. */
const uploadSchema = z.object({
  /** Largest original file, in megabytes. */
  UPLOAD_MAX_MB: positiveInt(50),
});

/**
 * The AI model that drafts notes: any OpenAI-compatible chat completions API
 * (Mistral, OpenAI, Azure OpenAI, a self-hosted model), or `fake`, which
 * drafts from the text without a model (development and tests).
 */
const aiSchema = z.discriminatedUnion("AI_PROVIDER", [
  z.object({
    AI_PROVIDER: z.literal("fake"),
    AI_DAILY_LIMIT: positiveInt(200),
  }),
  z.object({
    AI_PROVIDER: z.literal("openai-compatible"),
    /** The API's base URL, up to and including `/v1`. */
    AI_BASE_URL: required(httpUrl.transform(withoutTrailingSlash)),
    AI_API_KEY: requiredString(),
    AI_MODEL: requiredString(),
    /** Drafts per day, across all uploads; the rest waits for the next day. */
    AI_DAILY_LIMIT: positiveInt(200),
    AI_TIMEOUT_MS: positiveInt(120_000),
  }),
]);

/** Text recognition for scanned PDFs: a command such as `ocrmypdf`; off when unset. */
const ocrSchema = z.object({
  OCR_COMMAND: optional(z.string().min(1)),
  OCR_LANGUAGES: required(z.string().regex(/^[a-z_]+(\+[a-z_]+)*$/, 'must be Tesseract language codes such as "deu+eng"')),
});

/** The webhook: off until WEBHOOK_URL is set; then the signing secret is required. */
const webhookSchema = z
  .object({
    WEBHOOK_URL: optional(httpUrl),
    WEBHOOK_SECRET: optional(z.string().min(16, "must be at least 16 characters")),
  })
  .refine((env) => !env.WEBHOOK_URL || env.WEBHOOK_SECRET, {
    message: "is required with WEBHOOK_URL",
    path: ["WEBHOOK_SECRET"],
  });

/**
 * The Slack bot's intake: the web process accepts Slack's events only with
 * a valid signature. Off until SLACK_SIGNING_SECRET is set; the worker then
 * handles the messages with SLACK_BOT_TOKEN.
 */
const slackIntakeSchema = z.object({
  SLACK_SIGNING_SECRET: optional(z.string().min(1)),
});

const slackChannelId = z.string().regex(SLACK_CHANNEL_ID_PATTERN, "must be a Slack channel ID such as C0123456789");

/**
 * The weekly digest: a Slack channel and an email address (a list) for notes
 * for everyone. Teams set their own Slack channel in the library.
 */
const digestSchema = z.object({
  DIGEST_SLACK_CHANNEL_ID: optional(slackChannelId),
  DIGEST_EMAIL_TO: optional(z.email().transform((address) => address.toLowerCase())),
});

/** A list of domain names, separated by commas or spaces. Lower-cased. */
const domainList = z.preprocess(
  (value) =>
    typeof value === "string"
      ? value
          .split(/[\s,;]+/)
          .map((item) => item.trim().toLowerCase().replace(/^@/, ""))
          .filter(Boolean)
      : [],
  z.array(z.string().regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "must be domain names such as example.org")),
);

/**
 * The email intake: one mailbox the worker reads over IMAP. Off until
 * EMAIL_INTAKE_IMAP_URL is set; then the allowed sender domains are required.
 */
const emailIntakeSchema = z
  .object({
    EMAIL_INTAKE_IMAP_URL: optional(z.url({ protocol: /^imaps?$/, error: "must be an imaps:// (or imap://) URL with user and password" })),
    EMAIL_INTAKE_MAILBOX: requiredString(),
    EMAIL_INTAKE_DOMAINS: domainList,
    EMAIL_INTAKE_DONE_MAILBOX: optional(z.string().min(1)),
  })
  .superRefine((env, context) => {
    if (!env.EMAIL_INTAKE_IMAP_URL) return;
    const url = new URL(env.EMAIL_INTAKE_IMAP_URL);
    if (!url.username || !url.password) context.addIssue({ code: "custom", path: ["EMAIL_INTAKE_IMAP_URL"], message: "needs the user and password in the URL" });
    if (env.EMAIL_INTAKE_DOMAINS.length === 0) {
      context.addIssue({ code: "custom", path: ["EMAIL_INTAKE_DOMAINS"], message: "is required with EMAIL_INTAKE_IMAP_URL: list the domains staff send from" });
    }
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

export type DatabaseConfig = z.infer<typeof databaseSchema>;
export type AuthConfig = z.infer<typeof authSchema>;
export type DirectoryConfig = z.infer<typeof directorySchema>;
export type KeycloakDirectoryConfig = Extract<DirectoryConfig, { DIRECTORY: "keycloak" }>;
export type NotificationConfig = z.infer<typeof notificationSchema>;
export type StorageConfig = z.infer<typeof storageSchema>;
export type UploadConfig = z.infer<typeof uploadSchema>;
export type AiConfig = z.infer<typeof aiSchema>;
export type OcrConfig = z.infer<typeof ocrSchema>;
export type WebhookConfig = z.infer<typeof webhookSchema>;
export type VersionConfig = z.infer<typeof versionSchema>;
export type ErrorReportingConfig = z.infer<typeof errorReportingSchema>;
export type SlackIntakeConfig = z.infer<typeof slackIntakeSchema>;
export type DigestConfig = z.infer<typeof digestSchema>;
export type EmailIntakeConfig = z.infer<typeof emailIntakeSchema>;

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

export function parseAiConfig(env: Env = process.env): AiConfig {
  return parse(aiSchema, env);
}

export function parseOcrConfig(env: Env = process.env): OcrConfig {
  return parse(ocrSchema, env);
}

export function parseWebhookConfig(env: Env = process.env): WebhookConfig {
  return parse(webhookSchema, env);
}

export function parseVersionConfig(env: Env = process.env): VersionConfig {
  return parse(versionSchema, env);
}

export function parseErrorReportingConfig(env: Env = process.env): ErrorReportingConfig {
  return parse(errorReportingSchema, env);
}

export function parseSlackIntakeConfig(env: Env = process.env): SlackIntakeConfig {
  return parse(slackIntakeSchema, env);
}

export function parseDigestConfig(env: Env = process.env): DigestConfig {
  return parse(digestSchema, env);
}

export function parseEmailIntakeConfig(env: Env = process.env): EmailIntakeConfig {
  return parse(emailIntakeSchema, env);
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
  validate([databaseSchema, authSchema, directorySchema, storageSchema, uploadSchema, slackIntakeSchema, errorReportingSchema], env);
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
      aiSchema,
      ocrSchema,
      webhookSchema,
      digestSchema,
      emailIntakeSchema,
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
let aiConfig: AiConfig | undefined;
let ocrConfig: OcrConfig | undefined;
let webhookConfig: WebhookConfig | undefined;
let versionConfig: VersionConfig | undefined;
let errorReportingConfig: ErrorReportingConfig | undefined;
let slackIntakeConfig: SlackIntakeConfig | undefined;
let digestConfig: DigestConfig | undefined;
let emailIntakeConfig: EmailIntakeConfig | undefined;

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

export function getAiConfig(): AiConfig {
  aiConfig ??= parseAiConfig();
  return aiConfig;
}

export function getOcrConfig(): OcrConfig {
  ocrConfig ??= parseOcrConfig();
  return ocrConfig;
}

export function getWebhookConfig(): WebhookConfig {
  webhookConfig ??= parseWebhookConfig();
  return webhookConfig;
}

export function getVersionConfig(): VersionConfig {
  versionConfig ??= parseVersionConfig();
  return versionConfig;
}

export function getErrorReportingConfig(): ErrorReportingConfig {
  errorReportingConfig ??= parseErrorReportingConfig();
  return errorReportingConfig;
}

export function getSlackIntakeConfig(): SlackIntakeConfig {
  slackIntakeConfig ??= parseSlackIntakeConfig();
  return slackIntakeConfig;
}

export function getDigestConfig(): DigestConfig {
  digestConfig ??= parseDigestConfig();
  return digestConfig;
}

export function getEmailIntakeConfig(): EmailIntakeConfig {
  emailIntakeConfig ??= parseEmailIntakeConfig();
  return emailIntakeConfig;
}
