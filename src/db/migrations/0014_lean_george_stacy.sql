CREATE TYPE "public"."user_status" AS ENUM('active', 'archived', 'deleted');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" "user_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
-- Backfill: existing admin soft-deletes anonymised the handle to
-- '_deleted_<shortid>'. Map those rows to the new 'deleted' status so the
-- UsersSection filter can hide them without the pattern match.
UPDATE "users" SET "status" = 'deleted' WHERE "handle" LIKE '\_deleted\_%' ESCAPE '\';