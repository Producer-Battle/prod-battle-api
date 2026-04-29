-- Migration 0024: visible-lobby browser support.
-- New column:
--   matches.is_public - whether this match shows up in GET /lobbies.
-- Defaults to TRUE for the auto-discoverable modes (quickplay/ranked/flip/daily/tournament)
-- and FALSE for private rooms (host opts in via the create form).

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT TRUE;

-- Backfill: any pre-existing private-mode match should not appear in the
-- public browser even if a future host had toggled it on.
UPDATE matches SET is_public = FALSE WHERE mode = 'private';

-- Hot index for the lobby browser query: open lobbies that are visible.
CREATE INDEX IF NOT EXISTS matches_lobby_visible_idx
  ON matches (status, is_public)
  WHERE status = 'lobby';
