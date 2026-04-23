ALTER TYPE "public"."match_mode" ADD VALUE 'daily';--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "daily_date" date;--> statement-breakpoint
CREATE UNIQUE INDEX "matches_daily_date_unique" ON "matches" USING btree ("daily_date") WHERE "matches"."daily_date" IS NOT NULL;