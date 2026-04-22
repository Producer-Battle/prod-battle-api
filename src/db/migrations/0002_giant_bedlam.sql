ALTER TABLE "matches" DROP CONSTRAINT "matches_total_players_max_16";--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT "matches_team_size_range";--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_total_players_max_10" CHECK ("matches"."team_size" * "matches"."team_count" <= 10);--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_team_size_range" CHECK ("matches"."team_size" between 1 and 5);