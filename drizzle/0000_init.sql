CREATE TABLE "app_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"oidc_subject" text NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_sync_run" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"people_received" integer,
	"teams_received" integer,
	"access_granted" integer,
	"access_removed" integer,
	"sessions_ended" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "document_type" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_message" (
	"message_id" text PRIMARY KEY NOT NULL,
	"from_address" text,
	"person_id" uuid,
	"outcome" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "note_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"source_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"team_id" uuid,
	"visibility" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"core" text NOT NULL,
	"key_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quotes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"citation" text DEFAULT '' NOT NULL,
	"language" text,
	"document_type_id" uuid,
	"project_id" uuid,
	"uncertain_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_model" text,
	"drafted_at" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_id" uuid,
	"checked_at" timestamp with time zone,
	"checked_by_id" uuid,
	"published_at" timestamp with time zone,
	"discarded_at" timestamp with time zone,
	"edited_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('german', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(core, '')), 'B') || setweight(to_tsvector('english', coalesce(core, '')), 'B') || setweight(to_tsvector('german', coalesce(core, '')), 'B') || setweight(to_tsvector('simple', coalesce(search_text, '')), 'C') || setweight(to_tsvector('english', coalesce(search_text, '')), 'C') || setweight(to_tsvector('german', coalesce(search_text, '')), 'C')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_number_unique" UNIQUE("number"),
	CONSTRAINT "note_source_id_unique" UNIQUE("source_id"),
	CONSTRAINT "note_visibility_check" CHECK ("note"."visibility" in ('private', 'team', 'all')),
	CONSTRAINT "note_status_check" CHECK ("note"."status" in ('draft', 'published', 'discarded'))
);
--> statement-breakpoint
CREATE TABLE "note_reason" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"note_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_tag" (
	"note_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "note_tag_note_id_tag_id_pk" PRIMARY KEY("note_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "note_version" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"note_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"editor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_delivery" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"delivery_key" text NOT NULL,
	"event" text NOT NULL,
	"note_id" uuid,
	"recipient_id" uuid,
	"channel_id" text,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "notification_delivery_delivery_key_unique" UNIQUE("delivery_key"),
	CONSTRAINT "notification_delivery_channel_check" CHECK ("notification_delivery"."channel" in ('slack', 'email', 'slack_channel', 'email_address')),
	CONSTRAINT "notification_delivery_status_check" CHECK ("notification_delivery"."status" in ('pending', 'sent', 'skipped', 'failed')),
	CONSTRAINT "notification_delivery_recipient_check" CHECK (("notification_delivery"."channel" in ('slack_channel', 'email_address')) = ("notification_delivery"."recipient_id" is null and "notification_delivery"."channel_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"external_id" text,
	"oidc_subject" text,
	"display_name" text NOT NULL,
	"work_email" text,
	"team_id" uuid,
	"has_access" boolean DEFAULT false NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"access_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_in_directory_at" timestamp with time zone,
	"time_zone" text,
	"date_format" text,
	"slack_user_id" text,
	"slack_lookup_failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "person_oidc_subject_unique" UNIQUE("oidc_subject")
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "slack_event" (
	"event_id" text PRIMARY KEY NOT NULL,
	"slack_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"outcome" text,
	"person_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "slack_event_status_check" CHECK ("slack_event"."status" in ('received', 'processing', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"sha256" text,
	"url" text,
	"normalized_url" text,
	"doi" text,
	"file_name" text,
	"mime_type" text,
	"size_bytes" integer,
	"storage_key" text,
	"detected_title" text,
	"extraction_method" text,
	"extracted_at" timestamp with time zone,
	"text_chars" integer,
	"blocked_at" timestamp with time zone,
	"blocked_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_kind_check" CHECK ("source"."kind" in ('file', 'link')),
	CONSTRAINT "source_extraction_method_check" CHECK ("source"."extraction_method" is null or "source"."extraction_method" in ('pdf', 'docx', 'html', 'text', 'ocr'))
);
--> statement-breakpoint
CREATE TABLE "source_text" (
	"source_id" uuid PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_cleanup" (
	"storage_key" text PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "submission" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"source_id" uuid NOT NULL,
	"submitter_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_reason" text,
	"screen_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note_id" uuid,
	"released_at" timestamp with time zone,
	"released_by_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_channel_check" CHECK ("submission"."channel" in ('web', 'slack', 'email')),
	CONSTRAINT "submission_status_check" CHECK ("submission"."status" in ('received', 'processing', 'quarantined', 'duplicate', 'blocked', 'parked', 'drafted'))
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"cluster_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_cluster" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_proposal" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"note_id" uuid,
	"proposed_by_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"tag_id" uuid,
	"resolved_by_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_proposal_status_check" CHECK ("tag_proposal"."status" in ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "tag_subscription" (
	"person_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_subscription_person_id_tag_id_pk" PRIMARY KEY("person_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"external_id" text,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"digest_slack_channel_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_sync" (
	"note_id" uuid PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"requested_at" timestamp with time zone,
	"payload_hash" text,
	"delivered_at" timestamp with time zone,
	"ever_sent" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "webhook_sync_action_check" CHECK ("webhook_sync"."action" in ('publish', 'remove'))
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeat" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"beat_at" timestamp with time zone NOT NULL,
	"channels" jsonb
);
--> statement-breakpoint
ALTER TABLE "app_setting" ADD CONSTRAINT "app_setting_updated_by_id_person_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_id_person_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_message" ADD CONSTRAINT "email_message_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_owner_id_person_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_document_type_id_document_type_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_confirmed_by_id_person_id_fk" FOREIGN KEY ("confirmed_by_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_checked_by_id_person_id_fk" FOREIGN KEY ("checked_by_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_reason" ADD CONSTRAINT "note_reason_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_reason" ADD CONSTRAINT "note_reason_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_tag" ADD CONSTRAINT "note_tag_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_tag" ADD CONSTRAINT "note_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_version" ADD CONSTRAINT "note_version_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_version" ADD CONSTRAINT "note_version_editor_id_person_id_fk" FOREIGN KEY ("editor_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_recipient_id_person_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_event" ADD CONSTRAINT "slack_event_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_blocked_by_id_person_id_fk" FOREIGN KEY ("blocked_by_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_text" ADD CONSTRAINT "source_text_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_submitter_id_person_id_fk" FOREIGN KEY ("submitter_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_released_by_id_person_id_fk" FOREIGN KEY ("released_by_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_cluster_id_tag_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."tag_cluster"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_proposal" ADD CONSTRAINT "tag_proposal_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_proposal" ADD CONSTRAINT "tag_proposal_proposed_by_id_person_id_fk" FOREIGN KEY ("proposed_by_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_proposal" ADD CONSTRAINT "tag_proposal_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_proposal" ADD CONSTRAINT "tag_proposal_resolved_by_id_person_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_subscription" ADD CONSTRAINT "tag_subscription_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_subscription" ADD CONSTRAINT "tag_subscription_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_subject_idx" ON "audit_event" USING btree ("subject_type","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_account_user_id_idx" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_account_provider_account_idx" ON "auth_account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_id_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_session_oidc_subject_idx" ON "auth_session" USING btree ("oidc_subject");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "directory_sync_run_started_at_idx" ON "directory_sync_run" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_type_name_lower_idx" ON "document_type" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "note_status_published_at_idx" ON "note" USING btree ("status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "note_owner_idx" ON "note" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "note_team_idx" ON "note" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "note_search_vector_idx" ON "note" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "note_reason_note_idx" ON "note_reason" USING btree ("note_id","created_at");--> statement-breakpoint
CREATE INDEX "note_tag_tag_idx" ON "note_tag" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "note_version_note_version_idx" ON "note_version" USING btree ("note_id","version");--> statement-breakpoint
CREATE INDEX "notification_delivery_pending_idx" ON "notification_delivery" USING btree ("next_attempt_at") WHERE "notification_delivery"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "notification_delivery_status_idx" ON "notification_delivery" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "person_has_access_idx" ON "person" USING btree ("has_access");--> statement-breakpoint
CREATE INDEX "person_work_email_lower_idx" ON "person" USING btree (lower("work_email"));--> statement-breakpoint
CREATE UNIQUE INDEX "project_name_lower_idx" ON "project" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "slack_event_due_idx" ON "slack_event" USING btree ("next_attempt_at") WHERE "slack_event"."status" in ('received', 'processing');--> statement-breakpoint
CREATE UNIQUE INDEX "source_sha256_idx" ON "source" USING btree ("sha256") WHERE "source"."sha256" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "source_normalized_url_idx" ON "source" USING btree ("normalized_url") WHERE "source"."normalized_url" is not null;--> statement-breakpoint
CREATE INDEX "source_doi_idx" ON "source" USING btree ("doi");--> statement-breakpoint
CREATE INDEX "submission_status_idx" ON "submission" USING btree ("status","status_changed_at");--> statement-breakpoint
CREATE INDEX "submission_due_idx" ON "submission" USING btree ("next_attempt_at") WHERE "submission"."status" in ('received', 'processing');--> statement-breakpoint
CREATE INDEX "submission_submitter_idx" ON "submission" USING btree ("submitter_id","created_at");--> statement-breakpoint
CREATE INDEX "submission_source_idx" ON "submission" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_name_lower_idx" ON "tag" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "tag_cluster_name_lower_idx" ON "tag_cluster" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "tag_proposal_status_idx" ON "tag_proposal" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "tag_subscription_tag_idx" ON "tag_subscription" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "webhook_sync_requested_idx" ON "webhook_sync" USING btree ("next_attempt_at") WHERE "webhook_sync"."requested_at" is not null;