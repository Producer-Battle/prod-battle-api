-- Migration 0032: tournament showcase phase.
--
-- Between registration closing and round 1 opening, all entrants upload one
-- showcase track. The whole signed-in community can listen and score over a
-- configurable window (default 3 days). Top-scored entrant gets a
-- "crowd_favorite_<tournamentId>" achievement and honor bonus. Bracket then
-- runs as before - independent.
--
-- Idempotent (IF NOT EXISTS / IF NOT EXISTS everywhere) so it is safe to
-- re-run against a DB that has already been migrated.

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS showcase_seconds integer,
  ADD COLUMN IF NOT EXISTS showcase_starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS showcase_ends_at timestamptz;

CREATE TABLE IF NOT EXISTS tournament_showcase_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  audio_url text NOT NULL,
  title text,
  duration_sec integer,
  score numeric(10, 3) NOT NULL DEFAULT 0,
  final_rank integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, user_id)
);

CREATE INDEX IF NOT EXISTS tournament_showcase_submissions_tournament_idx
  ON tournament_showcase_submissions (tournament_id);

CREATE TABLE IF NOT EXISTS tournament_showcase_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES tournament_showcase_submissions(id) ON DELETE CASCADE,
  voter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weight numeric(10, 3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, voter_id)
);

CREATE INDEX IF NOT EXISTS tournament_showcase_votes_submission_idx
  ON tournament_showcase_votes (submission_id);

-- Seed showcase honor rules into the existing honor row.
-- Uses jsonb_set so it merges with whatever the admin may have tuned;
-- will not overwrite keys that already exist in the showcase sub-object.
UPDATE game_rules
  SET payload = jsonb_set(
    payload,
    '{showcase}',
    '{
      "voter_complete": 1,
      "crowd_favorite": 5,
      "runner_up": 2,
      "no_show": -1,
      "no_show_first_offence_factor": 0.5
    }'::jsonb,
    true
  )
  WHERE category = 'honor'
    AND NOT (payload ? 'showcase');
