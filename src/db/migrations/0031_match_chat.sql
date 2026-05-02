-- Migration 0031: per-match chat.
--
-- Lightweight room chat for the lobby/submit/upload/vote/results flow.
-- One row per message. Body is stripped of unicode emoji at the API
-- boundary for free users (paid + admin can emote). Read by the room
-- WS connection on join (last 50) and over Redis pub/sub for live new
-- messages.

CREATE TABLE IF NOT EXISTS match_chat (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  handle_snapshot text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS match_chat_match_id_created_at_idx
  ON match_chat (match_id, created_at);
