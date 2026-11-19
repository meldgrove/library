ALTER TABLE "person" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_role_check" CHECK ("person"."role" in ('member', 'maintainer', 'admin'));--> statement-breakpoint
-- Admins stay admins. Maintainers are new; admins appoint them.
UPDATE "person" SET "role" = 'admin' WHERE "is_admin";--> statement-breakpoint
ALTER TABLE "person" DROP COLUMN "is_admin";
