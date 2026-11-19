CREATE TABLE "topic_area" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note" ADD COLUMN "topic_area_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "topic_area_name_lower_idx" ON "topic_area" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_topic_area_id_topic_area_id_fk" FOREIGN KEY ("topic_area_id") REFERENCES "public"."topic_area"("id") ON DELETE no action ON UPDATE no action;