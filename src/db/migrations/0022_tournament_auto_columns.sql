-- Add submit_seconds_override and auto_created to tournaments.
-- submit_seconds_override: when set, all bracket matches in this tournament
--   use this submit duration instead of the mode default.
-- auto_created: true for rows created by the weekly cron; false for admin-
--   created rows. Drives idempotency check in weeklyTournamentScan.

ALTER TABLE "tournaments"
  ADD COLUMN IF NOT EXISTS "submit_seconds_override" INTEGER,
  ADD COLUMN IF NOT EXISTS "auto_created" BOOLEAN NOT NULL DEFAULT false;
