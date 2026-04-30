-- Migration 0028: add volatility to rankings for proper Glicko-2.
--
-- The existing glicko_rd column already exists. This adds the third
-- Glicko-2 parameter (sigma / volatility) with the Glickman default of 0.06.
-- Backfills existing rows with that default.

ALTER TABLE rankings
  ADD COLUMN IF NOT EXISTS glicko_volatility double precision NOT NULL DEFAULT 0.06;
