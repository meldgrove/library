import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { NotificationChannels, NotificationMessage } from "@/lib/notifications/types";
import type { DateFormat } from "@/lib/preferences";
import {
  EXTRACTION_METHODS,
  NOTE_STATUSES,
  SOURCE_KINDS,
  SUBMISSION_CHANNELS,
  SUBMISSION_STATUSES,
  TAG_PROPOSAL_STATUSES,
  VISIBILITIES,
  type ExtractionMethod,
  type NoteQuote,
  type NoteStatus,
  type ScreenFinding,
  type SlackMessage,
  type SourceKind,
  type SubmissionChannel,
  type SubmissionStatus,
  type TagProposalStatus,
  type Visibility,
} from "@/lib/library/constants";

/*
 * Database schema. Migrations are generated from this file with
 * `npm run db:generate` and live in `drizzle/`.
 *
 * People who lose access keep their row with `has_access = false`. Notes and
 * their sources can be deleted (copyright or privacy requests); the audit log
 * is append-only, enforced by a trigger (drizzle/0001_audit_append_only.sql),
 * and records only IDs and numbers of what was deleted.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const uuidv7PrimaryKey = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamptz("created_at").notNull().defaultNow();
const updatedAt = () => timestamptz("updated_at").notNull().defaultNow();

// ---------------------------------------------------------------------------
// Better Auth (models user, session, account, verification)
// ---------------------------------------------------------------------------

export const authUser = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const authSession = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamptz("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    /**
     * The OIDC `sub` this session logged in with. One Better Auth user can
     * have several (Better Auth links a new `sub` with the same verified
     * email), so the person behind a session is found by this, not by the user.
     */
    oidcSubject: text("oidc_subject").notNull(),
  },
  (table) => [
    index("auth_session_user_id_idx").on(table.userId),
    index("auth_session_oidc_subject_idx").on(table.oidcSubject),
  ],
);

export const authAccount = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    /** The OIDC `sub` of the user. */
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamptz("access_token_expires_at"),
    refreshTokenExpiresAt: timestamptz("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("auth_account_user_id_idx").on(table.userId),
    uniqueIndex("auth_account_provider_account_idx").on(table.providerId, table.accountId),
  ],
);

export const authVerification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("auth_verification_identifier_idx").on(table.identifier)],
);

// ---------------------------------------------------------------------------
// People and teams: managed in the library (manual directory) or synced from
// Keycloak (keycloak directory)
// ---------------------------------------------------------------------------

export const team = pgTable("team", {
  id: uuidv7PrimaryKey(),
  /** ID of the team in the external directory (the Keycloak group ID); empty for teams managed in the library. */
  externalId: text("external_id").unique(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  /** Slack channel that gets the team's weekly digest; set by stewards in the library, also with the Keycloak directory. */
  digestSlackChannelId: text("digest_slack_channel_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const person = pgTable(
  "person",
  {
    id: uuidv7PrimaryKey(),
    /** ID of the person in the external directory (the Keycloak user ID); empty for people managed in the library. */
    externalId: text("external_id").unique(),
    /**
     * The OIDC `sub`. Links the person to Better Auth's account row. Empty for
     * an invited person until their first login.
     */
    oidcSubject: text("oidc_subject").unique(),
    displayName: text("display_name").notNull(),
    workEmail: text("work_email"),
    teamId: uuid("team_id").references(() => team.id),
    hasAccess: boolean("has_access").notNull().default(false),
    isAdmin: boolean("is_admin").notNull().default(false),
    /** When `has_access` last changed. */
    accessChangedAt: timestamptz("access_changed_at").notNull().defaultNow(),
    /** Last directory sync that listed the person; empty for people managed in the library. */
    lastSeenInDirectoryAt: timestamptz("last_seen_in_directory_at"),
    /** IANA time zone for dates and times; empty means the server's time zone. */
    timeZone: text("time_zone"),
    /** How dates are written; empty means the default (DD.MM.YYYY). */
    dateFormat: text("date_format").$type<DateFormat>(),
    /** Slack user ID, looked up by `work_email` and cached. */
    slackUserId: text("slack_user_id"),
    /** Set when no Slack user was found; the lookup is retried after a week. */
    slackLookupFailedAt: timestamptz("slack_lookup_failed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("person_has_access_idx").on(table.hasAccess),
    index("person_work_email_lower_idx").on(sql`lower(${table.workEmail})`),
  ],
);

export const directorySyncRun = pgTable(
  "directory_sync_run",
  {
    id: uuidv7PrimaryKey(),
    /** What started the run: schedule, startup, login, admin, or manual. */
    trigger: text("trigger").notNull(),
    /** running, succeeded, or failed. */
    status: text("status").notNull(),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    finishedAt: timestamptz("finished_at"),
    peopleReceived: integer("people_received"),
    teamsReceived: integer("teams_received"),
    accessGranted: integer("access_granted"),
    accessRemoved: integer("access_removed"),
    sessionsEnded: integer("sessions_ended"),
    error: text("error"),
  },
  (table) => [index("directory_sync_run_started_at_idx").on(table.startedAt)],
);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const workerHeartbeat = pgTable("worker_heartbeat", {
  workerId: text("worker_id").primaryKey(),
  startedAt: timestamptz("started_at").notNull(),
  beatAt: timestamptz("beat_at").notNull(),
  /** How the worker sends notifications, shown on the admin page. */
  channels: jsonb("channels").$type<NotificationChannels>(),
});

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
const sqlList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

// ---------------------------------------------------------------------------
// Taxonomy: closed lists the AI picks from; stewards maintain them
// ---------------------------------------------------------------------------

export const tagCluster = pgTable(
  "tag_cluster",
  {
    id: uuidv7PrimaryKey(),
    name: text("name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("tag_cluster_name_lower_idx").on(sql`lower(${table.name})`)],
);

export const tag = pgTable(
  "tag",
  {
    id: uuidv7PrimaryKey(),
    name: text("name").notNull(),
    /** One line on what the tag covers; given to the AI model with the tag. */
    description: text("description").notNull().default(""),
    clusterId: uuid("cluster_id").references(() => tagCluster.id),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("tag_name_lower_idx").on(sql`lower(${table.name})`)],
);

/** Study, report, article, … */
export const documentType = pgTable(
  "document_type",
  {
    id: uuidv7PrimaryKey(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("document_type_name_lower_idx").on(sql`lower(${table.name})`)],
);

/** Programs and projects a note can belong to. */
export const project = pgTable(
  "project",
  {
    id: uuidv7PrimaryKey(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("project_name_lower_idx").on(sql`lower(${table.name})`)],
);

// ---------------------------------------------------------------------------
// Sources and submissions: what people upload, and its way through the worker
// ---------------------------------------------------------------------------

/**
 * One external source: an uploaded file or a link. Files are stored once per
 * SHA-256; links once per normalized URL. A source has at most one note.
 */
export const source = pgTable(
  "source",
  {
    id: uuidv7PrimaryKey(),
    kind: text("kind").$type<SourceKind>().notNull(),
    /** SHA-256 of the original file (hex); empty for links that are web pages. */
    sha256: text("sha256"),
    /** The link as given. */
    url: text("url"),
    /** The link without tracking parameters, fragment, and trailing slash; used to find duplicates. */
    normalizedUrl: text("normalized_url"),
    /** A DOI found in the text, lower-cased; used to find duplicates. */
    doi: text("doi"),
    fileName: text("file_name"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    /** Key of the original in object storage; empty when only text was kept (web pages). */
    storageKey: text("storage_key"),
    /** Title from the document's metadata or the page, before the AI draft. */
    detectedTitle: text("detected_title"),
    extractionMethod: text("extraction_method").$type<ExtractionMethod>(),
    extractedAt: timestamptz("extracted_at"),
    textChars: integer("text_chars"),
    /** Set when a draft was discarded: uploads of the same source stop at the duplicate check. */
    blockedAt: timestamptz("blocked_at"),
    blockedById: uuid("blocked_by_id").references(() => person.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("source_sha256_idx").on(table.sha256).where(sql`${table.sha256} is not null`),
    uniqueIndex("source_normalized_url_idx").on(table.normalizedUrl).where(sql`${table.normalizedUrl} is not null`),
    index("source_doi_idx").on(table.doi),
    check("source_kind_check", sql`${table.kind} in (${sqlList(SOURCE_KINDS)})`),
    check(
      "source_extraction_method_check",
      sql`${table.extractionMethod} is null or ${table.extractionMethod} in (${sqlList(EXTRACTION_METHODS)})`,
    ),
  ],
);

/** The extracted text of a source, kept for re-drafting and checking quotes. */
export const sourceText = pgTable("source_text", {
  sourceId: uuid("source_id")
    .primaryKey()
    .references(() => source.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  createdAt: createdAt(),
});

/**
 * One upload by one person. The worker moves it from `received` to a note
 * (`drafted`), or stops it: `quarantined` (screen hit), `duplicate` (the source
 * has a note), `blocked` (the source was discarded), or `parked` (extraction or
 * the AI draft failed; a steward decides).
 */
export const submission = pgTable(
  "submission",
  {
    id: uuidv7PrimaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    submitterId: uuid("submitter_id")
      .notNull()
      .references(() => person.id),
    channel: text("channel").$type<SubmissionChannel>().notNull(),
    /** One line from the uploader on why the source is useful. */
    reason: text("reason").notNull().default(""),
    status: text("status").$type<SubmissionStatus>().notNull().default("received"),
    statusChangedAt: timestamptz("status_changed_at").notNull().defaultNow(),
    /** Why the worker stopped (quarantined, parked, blocked), for the uploader and the steward. */
    statusReason: text("status_reason"),
    screenFindings: jsonb("screen_findings").$type<ScreenFinding[]>().notNull().default(sql`'[]'::jsonb`),
    /** The note this upload became, or the existing note it duplicates. */
    noteId: uuid("note_id").references((): AnyPgColumn => note.id, { onDelete: "set null" }),
    /** A steward let a quarantined upload pass the screen. */
    releasedAt: timestamptz("released_at"),
    releasedById: uuid("released_by_id").references(() => person.id),
    attempts: integer("attempts").notNull().default(0),
    /** When the worker takes it up again (after a temporary error or when the AI budget is used up). */
    nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("submission_status_idx").on(table.status, table.statusChangedAt),
    index("submission_due_idx").on(table.nextAttemptAt).where(sql`${table.status} in ('received', 'processing')`),
    index("submission_submitter_idx").on(table.submitterId, table.createdAt),
    index("submission_source_idx").on(table.sourceId),
    check("submission_channel_check", sql`${table.channel} in (${sqlList(SUBMISSION_CHANNELS)})`),
    check("submission_status_check", sql`${table.status} in (${sqlList(SUBMISSION_STATUSES)})`),
  ],
);

export const INTAKE_STATUSES = ["received", "processing", "done", "failed"] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

/**
 * A direct message to the Slack bot, stored by the web process as Slack sent
 * it (keyed by its event ID, so Slack's retries are recorded once) and handled
 * by the worker: it finds the person, downloads files, and submits.
 */
export const slackEvent = pgTable(
  "slack_event",
  {
    eventId: text("event_id").primaryKey(),
    /** The Slack user who wrote the message. */
    slackUserId: text("slack_user_id").notNull(),
    /** The direct message channel (D…); replies to unknown people go there. */
    channelId: text("channel_id").notNull(),
    message: jsonb("message").$type<SlackMessage>().notNull(),
    status: text("status").$type<IntakeStatus>().notNull().default("received"),
    /** What came of it: added, refused, no_reason, nothing_to_add, rate_limited, unknown_person. */
    outcome: text("outcome"),
    /** The person found by the Slack user's email address. */
    personId: uuid("person_id").references(() => person.id),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
    processedAt: timestamptz("processed_at"),
  },
  (table) => [
    index("slack_event_due_idx").on(table.nextAttemptAt).where(sql`${table.status} in ('received', 'processing')`),
    check("slack_event_status_check", sql`${table.status} in (${sqlList(INTAKE_STATUSES)})`),
  ],
);

/**
 * An email to the intake mailbox, by its Message-ID, once the worker has
 * handled it, so a message is never handled twice. No subject or body.
 */
export const emailMessage = pgTable("email_message", {
  messageId: text("message_id").primaryKey(),
  /** The sender's address, lower-cased. */
  fromAddress: text("from_address"),
  /** The person with access behind the address, when the message was accepted. */
  personId: uuid("person_id").references(() => person.id),
  /** added, refused, no_reason, nothing_to_add, rate_limited, no_access, or why it was refused unanswered. */
  outcome: text("outcome").notNull(),
  processedAt: timestamptz("processed_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * The structured source note: drafted by the AI model, confirmed by its owner
 * (the uploader), and then published. Shown as LIB-<number>.
 */
export const note = pgTable(
  "note",
  {
    id: uuidv7PrimaryKey(),
    number: integer("number").notNull().unique().generatedAlwaysAsIdentity(),
    sourceId: uuid("source_id")
      .notNull()
      .unique()
      .references(() => source.id),
    /** Reviews the draft and answers for the note: the first uploader. */
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => person.id),
    /** The owning team; "team" visibility means its members. */
    teamId: uuid("team_id").references(() => team.id),
    visibility: text("visibility").$type<Visibility>().notNull(),
    status: text("status").$type<NoteStatus>().notNull().default("draft"),
    title: text("title").notNull(),
    /** The core in 2–3 sentences. */
    core: text("core").notNull(),
    keyPoints: jsonb("key_points").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    quotes: jsonb("quotes").$type<NoteQuote[]>().notNull().default(sql`'[]'::jsonb`),
    citation: text("citation").notNull().default(""),
    /** ISO 639-1 code of the source's language. */
    language: text("language"),
    documentTypeId: uuid("document_type_id").references(() => documentType.id),
    projectId: uuid("project_id").references(() => project.id),
    /** Fields the AI model was unsure about; the review screen marks them. */
    uncertainFields: jsonb("uncertain_fields").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    draftModel: text("draft_model"),
    draftedAt: timestamptz("drafted_at"),
    /** Review reminders: after a week to the owner, after 30 days to the stewards. */
    reminderSentAt: timestamptz("reminder_sent_at"),
    escalatedAt: timestamptz("escalated_at"),
    confirmedAt: timestamptz("confirmed_at"),
    confirmedById: uuid("confirmed_by_id").references(() => person.id),
    /** A steward checked the published note. */
    checkedAt: timestamptz("checked_at"),
    checkedById: uuid("checked_by_id").references(() => person.id),
    publishedAt: timestamptz("published_at"),
    discardedAt: timestamptz("discarded_at"),
    editedAt: timestamptz("edited_at"),
    version: integer("version").notNull().default(1),
    /** Key points, quotes, citation, and tag names, kept by the notes module for search. */
    searchText: text("search_text").notNull().default(""),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('german', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(core, '')), 'B') || setweight(to_tsvector('english', coalesce(core, '')), 'B') || setweight(to_tsvector('german', coalesce(core, '')), 'B') || setweight(to_tsvector('simple', coalesce(search_text, '')), 'C') || setweight(to_tsvector('english', coalesce(search_text, '')), 'C') || setweight(to_tsvector('german', coalesce(search_text, '')), 'C')`,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("note_status_published_at_idx").on(table.status, table.publishedAt.desc()),
    index("note_owner_idx").on(table.ownerId, table.status),
    index("note_team_idx").on(table.teamId),
    index("note_search_vector_idx").using("gin", table.searchVector),
    check("note_visibility_check", sql`${table.visibility} in (${sqlList(VISIBILITIES)})`),
    check("note_status_check", sql`${table.status} in (${sqlList(NOTE_STATUSES)})`),
  ],
);

export const noteTag = pgTable(
  "note_tag",
  {
    noteId: uuid("note_id")
      .notNull()
      .references(() => note.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tag.id),
  },
  (table) => [primaryKey({ columns: [table.noteId, table.tagId] }), index("note_tag_tag_idx").on(table.tagId)],
);

/** Tags a person follows: their weekly email lists new notes with these tags. */
export const tagSubscription = pgTable(
  "tag_subscription",
  {
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tag.id),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.personId, table.tagId] }), index("tag_subscription_tag_idx").on(table.tagId)],
);

/** Who added a source and why: the first uploader, and everyone whose upload was a duplicate. */
export const noteReason = pgTable(
  "note_reason",
  {
    id: uuidv7PrimaryKey(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => note.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("note_reason_note_idx").on(table.noteId, table.createdAt)],
);

/** Each saved state of a note, for its history. */
export const noteVersion = pgTable(
  "note_version",
  {
    id: uuidv7PrimaryKey(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => note.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    editorId: uuid("editor_id").references(() => person.id),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("note_version_note_version_idx").on(table.noteId, table.version)],
);

/** A tag the AI model or a person asked for that is not in the list. Stewards accept or reject it. */
export const tagProposal = pgTable(
  "tag_proposal",
  {
    id: uuidv7PrimaryKey(),
    name: text("name").notNull(),
    noteId: uuid("note_id").references(() => note.id, { onDelete: "cascade" }),
    /** Empty when the AI model proposed it. */
    proposedById: uuid("proposed_by_id").references(() => person.id),
    status: text("status").$type<TagProposalStatus>().notNull().default("pending"),
    /** The tag it became, or the existing tag it was mapped to. */
    tagId: uuid("tag_id").references(() => tag.id),
    resolvedById: uuid("resolved_by_id").references(() => person.id),
    resolvedAt: timestamptz("resolved_at"),
    createdAt: createdAt(),
  },
  (table) => [
    index("tag_proposal_status_idx").on(table.status, table.createdAt),
    check("tag_proposal_status_check", sql`${table.status} in (${sqlList(TAG_PROPOSAL_STATUSES)})`),
  ],
);

// ---------------------------------------------------------------------------
// Audit, limits, settings
// ---------------------------------------------------------------------------

/**
 * Append-only (enforced by a trigger). `subject_id` has no foreign key, so
 * events about deleted notes and sources stay. Payloads never hold the text
 * of a deleted note.
 */
export const auditEvent = pgTable(
  "audit_event",
  {
    id: uuidv7PrimaryKey(),
    actorId: uuid("actor_id").references(() => person.id),
    action: text("action").notNull(),
    /** note, submission, source, tag, document_type, project, person, or team. */
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (table) => [index("audit_event_subject_idx").on(table.subjectType, table.subjectId, table.createdAt)],
);

/** Fixed-window counters for per-person write limits and the AI draft budget. */
export const rateLimit = pgTable(
  "rate_limit",
  {
    key: text("key").notNull(),
    windowStart: timestamptz("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.key, table.windowStart] })],
);

/** Admin settings. */
export const appSetting = pgTable("app_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedById: uuid("updated_by_id").references(() => person.id),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * `slack_channel`: a post to a Slack channel; `email_address`: an email to an
 * address such as a mailing list. Both name `channel_id` and no recipient person.
 */
export const NOTIFICATION_CHANNELS = ["slack", "email", "slack_channel", "email_address"] as const;
/** Channels whose messages go to `channel_id` instead of a person. */
export const ADDRESS_CHANNELS = ["slack_channel", "email_address"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const DELIVERY_STATUSES = ["pending", "sent", "skipped", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * One message to one person (or one Slack channel) on one channel. Commands
 * insert rows in their own transaction; only the worker sends them.
 * `delivery_key` is unique, so a notification is recorded, and sent, at most once.
 */
export const notificationDelivery = pgTable(
  "notification_delivery",
  {
    id: uuidv7PrimaryKey(),
    deliveryKey: text("delivery_key").notNull().unique(),
    event: text("event").notNull(),
    noteId: uuid("note_id").references(() => note.id, { onDelete: "set null" }),
    /** Empty exactly for posts to a Slack channel and emails to an address. */
    recipientId: uuid("recipient_id").references(() => person.id),
    /** The Slack channel ID of a channel post, or the email address. */
    channelId: text("channel_id"),
    channel: text("channel").$type<NotificationChannel>().notNull(),
    status: text("status").$type<DeliveryStatus>().notNull().default("pending"),
    message: jsonb("message").$type<NotificationMessage>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
    createdAt: createdAt(),
    sentAt: timestamptz("sent_at"),
    /** The last error, or why the message was skipped. */
    lastError: text("last_error"),
  },
  (table) => [
    index("notification_delivery_pending_idx").on(table.nextAttemptAt).where(sql`${table.status} = 'pending'`),
    index("notification_delivery_status_idx").on(table.status, table.createdAt),
    check("notification_delivery_channel_check", sql`${table.channel} in (${sqlList(NOTIFICATION_CHANNELS)})`),
    check("notification_delivery_status_check", sql`${table.status} in (${sqlList(DELIVERY_STATUSES)})`),
    check(
      "notification_delivery_recipient_check",
      sql`(${table.channel} in (${sqlList(ADDRESS_CHANNELS)})) = (${table.recipientId} is null and ${table.channelId} is not null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export const WEBHOOK_ACTIONS = ["publish", "remove"] as const;
export type WebhookAction = (typeof WEBHOOK_ACTIONS)[number];

/**
 * What the webhook receiver should hold of a note. Commands set
 * `requested_at` in their transaction; the worker sends and clears it. No
 * foreign key: the removal of a deleted note must still go out.
 */
export const webhookSync = pgTable(
  "webhook_sync",
  {
    noteId: uuid("note_id").primaryKey(),
    /** publish: send the note as it is now (note.changed); remove: note.removed. */
    action: text("action").$type<WebhookAction>().notNull(),
    requestedAt: timestamptz("requested_at"),
    /** Hash of the last payload the receiver accepted, so unchanged notes are not sent again. */
    payloadHash: text("payload_hash"),
    deliveredAt: timestamptz("delivered_at"),
    /** The receiver has (or had) this note, so a removal must be sent. */
    everSent: boolean("ever_sent").notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamptz("next_attempt_at"),
    lastError: text("last_error"),
  },
  (table) => [
    index("webhook_sync_requested_idx").on(table.nextAttemptAt).where(sql`${table.requestedAt} is not null`),
    check("webhook_sync_action_check", sql`${table.action} in (${sqlList(WEBHOOK_ACTIONS)})`),
  ],
);

/**
 * Originals to delete once no source uses them. Deletions write the key in
 * their transaction; the worker retries until storage confirms, so a storage
 * outage cannot leave a deleted note's original behind.
 */
export const storageCleanup = pgTable("storage_cleanup", {
  storageKey: text("storage_key").primaryKey(),
  requestedAt: timestamptz("requested_at").notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
  lastError: text("last_error"),
});
