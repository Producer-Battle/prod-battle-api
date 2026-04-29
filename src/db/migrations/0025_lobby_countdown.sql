-- Migration 0025: lobby auto-start countdown.
-- New column:
--   matches.lobby_starts_at - timestamptz the orchestrator schedules when the
--                             lobby has reached the auto-fire min (3 seated
--                             players in qp/ranked/flip). When the time
--                             arrives, the tick loop transitions the match
--                             from 'lobby' to 'submit'. NULL means "not
--                             scheduled yet" (waiting for more players, or
--                             a private/daily/tournament match that does
--                             not auto-fire).

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS lobby_starts_at TIMESTAMPTZ;

-- Hot index for the orchestrator sweep: lobby-phase matches whose countdown
-- is due. Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS matches_lobby_starts_at_due_idx
  ON matches (lobby_starts_at)
  WHERE status = 'lobby' AND lobby_starts_at IS NOT NULL;
