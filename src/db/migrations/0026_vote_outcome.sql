-- Migration 0026: persisted vote outcome.
-- New column:
--   matches.vote_outcome - 'complete' | 'incomplete' | NULL.
-- Set by the tick worker when the vote phase ends. NULL while the match is
-- still pre-results. Used to (a) suppress ranked LP updates on incomplete
-- matches so the leaderboard signal stays clean and (b) surface a "partial
-- tally" pill on the Results UI.

CREATE TYPE vote_outcome AS ENUM ('complete', 'incomplete');

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS vote_outcome vote_outcome;
