-- Migration 0036: support tickets and threaded replies.
--
-- Two tables: support_tickets (one row per request) and
-- support_ticket_replies (one row per message in the thread).
-- Status lifecycle: open -> answered -> closed.
-- Quota enforcement (4/day) is handled at the API layer, not here.

CREATE TYPE ticket_status AS ENUM ('open', 'answered', 'closed');
CREATE TYPE ticket_author_role AS ENUM ('user', 'admin');

CREATE TABLE IF NOT EXISTS support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject varchar(120) NOT NULL,
  status ticket_status NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_tickets_user_id_idx
  ON support_tickets (user_id);

CREATE TABLE IF NOT EXISTS support_ticket_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_role ticket_author_role NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_ticket_replies_ticket_id_idx
  ON support_ticket_replies (ticket_id);
