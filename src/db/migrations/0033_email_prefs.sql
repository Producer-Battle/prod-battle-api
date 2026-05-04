-- Migration 0033: per-user email notification preferences.
--
-- Adds email_prefs JSONB to users (all categories default true so
-- existing users keep receiving all mail until they opt out).
--
-- Also adds tournament_reminders_sent for the 24h-before-tournament
-- cron - INSERT ON CONFLICT DO NOTHING provides idempotency so each
-- (tournament, user) pair only generates one reminder email.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_prefs jsonb NOT NULL DEFAULT
    '{"tournament_activity":true,"daily_activity":true,"match_results":true,"honor_alerts":true,"account_security":true,"billing":true}'::jsonb;

CREATE TABLE IF NOT EXISTS tournament_reminders_sent (
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, user_id)
);
