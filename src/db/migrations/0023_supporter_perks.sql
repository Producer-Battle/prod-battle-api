-- Migration 0023: Supporter perk pack
-- New columns:
--   users.accent_color       - hex accent color for profile ring (perk 4)
--   producer_profiles.pinned_submission_ids - up to 3 pinned track UUIDs (perk 6)
-- New table:
--   monthly_playlists        - admin-curated supporter-only monthly playlists (perk 7)

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS accent_color VARCHAR(16);

ALTER TABLE producer_profiles
  ADD COLUMN IF NOT EXISTS pinned_submission_ids UUID[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS monthly_playlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  month DATE NOT NULL,
  curator_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  submission_ids UUID[] NOT NULL DEFAULT '{}',
  published_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT monthly_playlists_month_unique UNIQUE (month)
);
