CREATE TABLE "achievements" (
	"user_id" uuid NOT NULL,
	"achievement_key" text NOT NULL,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden_by_user" boolean DEFAULT false NOT NULL,
	CONSTRAINT "achievements_user_id_achievement_key_pk" PRIMARY KEY("user_id","achievement_key")
);
--> statement-breakpoint
CREATE TABLE "game_rules" (
	"category" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "pack_plays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"played_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_players" ADD COLUMN "abandoned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "match_players" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "match_players" ADD COLUMN "honor_delta" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "match_players" ADD COLUMN "lp_delta" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "honor" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "calibration_matches_remaining" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_visibility" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "achievements" ADD CONSTRAINT "achievements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_rules" ADD CONSTRAINT "game_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_plays" ADD CONSTRAINT "pack_plays_pack_id_sample_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."sample_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_plays" ADD CONSTRAINT "pack_plays_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ─── Seed: quarterly seasons for the next year ──────────────────────────────
-- Pre-create seasons so we never need a rollover cron. Active season at any
-- moment = WHERE starts_at <= now() AND ends_at > now(). Idempotent via
-- ON CONFLICT (slug) DO NOTHING so re-running the migration is safe.
INSERT INTO "seasons" ("slug", "starts_at", "ends_at") VALUES
  ('2026-q2', '2026-04-01T00:00:00Z', '2026-07-01T00:00:00Z'),
  ('2026-q3', '2026-07-01T00:00:00Z', '2026-10-01T00:00:00Z'),
  ('2026-q4', '2026-10-01T00:00:00Z', '2027-01-01T00:00:00Z'),
  ('2027-q1', '2027-01-01T00:00:00Z', '2027-04-01T00:00:00Z'),
  ('2027-q2', '2027-04-01T00:00:00Z', '2027-07-01T00:00:00Z')
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint

-- ─── Seed: default game rules ───────────────────────────────────────────────
-- Admin can edit any of these via /admin?tab=rules. App code reads via the
-- gameRules cache (src/game-rules/loader.ts). Idempotent via ON CONFLICT.
INSERT INTO "game_rules" ("category", "payload") VALUES
  ('honor', '{
    "start": 100,
    "max": 100,
    "regenPerCleanDay": 1,
    "regenBurstPerCleanQpMatches": {"matches": 10, "amount": 5},
    "firstOffenceWindowDays": 30,
    "firstOffenceMultiplier": 0.5,
    "penalties": {
      "quickplay_lobby": -1,
      "quickplay_mid": -2,
      "quickplay_empty": -3,
      "ranked_lobby": -2,
      "ranked_mid": -5,
      "ranked_empty": -3,
      "private_lobby": -1,
      "private_mid": -2,
      "private_empty": -2,
      "flip_lobby": -1,
      "flip_mid": -2,
      "flip_empty": -3,
      "daily_lobby": -1,
      "daily_mid": -2,
      "daily_empty": -3,
      "tournament_lobby": -3,
      "tournament_mid": -10,
      "tournament_empty": -5,
      "dmca_first": -5,
      "dmca_second": -15,
      "dmca_third": -25,
      "vote_ring_confirmed": -50
    },
    "gates": {
      "tournament": 70,
      "ranked": 50,
      "privateHosting": 30,
      "readOnlyBelow": 10
    },
    "perks": {
      "trustedAt": 90,
      "voteWeightBoostAt": 90,
      "voteWeightBoostMultiplier": 1.5,
      "extraQuickplaySlotAt": 95,
      "extraQuickplaySlotAfterDays": 30
    }
  }'),
  ('tiers', '{
    "calibrationMatches": 10,
    "softResetPercent": 0.6,
    "softResetFloorOffset": -1,
    "lpClampBase": 30,
    "lpClampPerLp": 200,
    "boundaries": [
      {"name": "bronze", "min": 0, "max": 100},
      {"name": "silver", "min": 100, "max": 250},
      {"name": "gold", "min": 250, "max": 500},
      {"name": "platinum", "min": 500, "max": 1000},
      {"name": "diamond", "min": 1000, "max": 2000},
      {"name": "master", "min": 2000, "max": 3500},
      {"name": "grandmaster", "min": 3500, "max": null}
    ],
    "subdivisions": 3,
    "promoSeriesEnabled": false
  }'),
  ('voting', '{
    "minMatchesBeforeVotesCount": 3,
    "selfVoteAllowed": false,
    "downvotesEnabled": false,
    "honorWeightCurve": [
      {"honorMin": 0, "weight": 0},
      {"honorMin": 30, "weight": 1.0},
      {"honorMin": 90, "weight": 1.5},
      {"honorMin": 100, "weight": 1.5}
    ],
    "premiumVoteWeightBonus": 0.25,
    "velocityCapPerSubmissionPerHour": 30,
    "ringDetection": {
      "enabled": true,
      "minMutualVotePairs": 5,
      "maxIntervalMinutes": 5
    }
  }'),
  ('revenue', '{
    "creatorPoolPercentOfPremium": 5,
    "minPayoutThresholdCents": 500,
    "rolloverIfBelow": true,
    "payoutCadenceDays": 30
  }'),
  ('achievements', '{
    "enabled": {
      "match_streak_7": true,
      "match_streak_30": true,
      "match_lifetime_100": true,
      "match_lifetime_1000": true,
      "votes_lifetime_100": true,
      "daily_champion": true,
      "weekly_pick": true,
      "genre_mastery_10": true,
      "active_listener_10": true,
      "trusted_honor": true,
      "honor_streak_90": true,
      "pack_creator_first": true,
      "pack_iconic_500": true,
      "pack_producers_producer_5": true,
      "tier_silver": true,
      "tier_gold": true,
      "tier_plat": true,
      "tier_diamond": true,
      "tier_master": true,
      "tier_grandmaster": true,
      "season_finalist_top10": true,
      "remix_master_10": true,
      "remix_master_50": true,
      "tournament_winner": true
    }
  }'),
  ('reconnect', '{
    "graceSeconds": 120,
    "lobbyAutoReadyTimeoutSeconds": 60,
    "heartbeatIntervalSeconds": 15
  }')
ON CONFLICT ("category") DO NOTHING;