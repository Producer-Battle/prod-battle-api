ALTER TYPE "public"."match_mode" ADD VALUE 'flip';--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "flip_source_id" uuid;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_flip_source_id_flip_sources_id_fk" FOREIGN KEY ("flip_source_id") REFERENCES "public"."flip_sources"("id") ON DELETE set null ON UPDATE no action;