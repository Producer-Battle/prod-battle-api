CREATE TYPE "public"."sample_mode" AS ENUM('none', 'generated', 'uploaded');--> statement-breakpoint
CREATE TYPE "public"."sample_pack_kind" AS ENUM('uploaded', 'generated', 'pool');--> statement-breakpoint
CREATE TABLE "sample_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"genre_id" uuid NOT NULL,
	"kind" "sample_pack_kind" NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid,
	"samples" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT "matches_total_players_max_8";--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT "matches_team_size_range";--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT "matches_team_count_range";--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "sample_mode" "sample_mode" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "sample_pack_id" uuid;--> statement-breakpoint
ALTER TABLE "sample_packs" ADD CONSTRAINT "sample_packs_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "public"."genres"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_packs" ADD CONSTRAINT "sample_packs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_sample_pack_id_sample_packs_id_fk" FOREIGN KEY ("sample_pack_id") REFERENCES "public"."sample_packs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_total_players_max_16" CHECK ("matches"."team_size" * "matches"."team_count" <= 16);--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_team_size_range" CHECK ("matches"."team_size" between 1 and 8);--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_team_count_range" CHECK ("matches"."team_count" between 1 and 8);