-- Migration 0035: add bracket_enabled flag to tournaments.
-- Default true preserves existing behavior; weekly auto-created rows
-- will be inserted with bracket_enabled = false going forward.
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS bracket_enabled boolean NOT NULL DEFAULT true;
