-- clear-prod.sql
--
-- Wipe all match data + producer users from a prod database while leaving
-- admin and A&R users intact.
--
-- Review this file before running. To execute directly:
--
--   psql "$DATABASE_URL" -f scripts/clear-prod.sql
--
-- Or use the TypeScript wrapper (recommended - adds safety checks):
--
--   pnpm clear-prod --confirm    # requires CONFIRM_CLEAR=yes in env

BEGIN;

-- Match data (CASCADE handles child tables automatically)
TRUNCATE TABLE matches, battle_phases, match_teams, match_players,
               submissions, submission_likes, submission_tags, votes
  RESTART IDENTITY CASCADE;

-- Producer users (admin + ar survive)
DELETE FROM users WHERE role = 'producer';

-- User-uploaded sample packs that are no longer owned by anyone
DELETE FROM sample_packs WHERE kind = 'uploaded' AND created_by IS NULL;

-- User-uploaded flip sources that are no longer owned by anyone
DELETE FROM flip_sources WHERE source = 'upload' AND created_by IS NULL;

COMMIT;
