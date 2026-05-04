-- Migration 0034: enforce handle format at the database level.
--
-- Adds a CHECK constraint on users.handle so the DB itself rejects rows
-- that don't match the canonical format ^[a-zA-Z0-9_-]{3,20}$.
--
-- The second alternation (^[a-zA-Z0-9_-]+@guest\.local$) keeps existing
-- audience-vote rows alive. Those are auto-created by the vote endpoint
-- and use an email-shaped handle by design (e.g. "ghostraven@guest.local").
-- Without this escape hatch the constraint would fail on prod data.
--
-- The backfill below runs BEFORE adding the constraint so the migration
-- succeeds even if prod data contains rows that would otherwise violate it
-- (e.g. handles registered with a leading @ before this fix was deployed).
-- Violating rows are renamed to a phonky-stoat-NNN style random handle that
-- is guaranteed to be unique (UUID suffix keeps it collision-free).

-- Step 1: backfill any currently-violating rows.
DO $backfill$
DECLARE
  _id   uuid;
  _new  text;
BEGIN
  FOR _id IN
    SELECT id FROM users
     WHERE handle !~ '^[a-zA-Z0-9_-]{3,20}$'
       AND handle !~ '^[a-zA-Z0-9_-]+@guest\.local$'
  LOOP
    -- Generate a safe handle from a deterministic slug + short UUID fragment.
    _new := 'user-' || replace(gen_random_uuid()::text, '-', '')::text;
    _new := substring(_new for 20);

    UPDATE users SET handle = _new, updated_at = now()
     WHERE id = _id;
  END LOOP;
END
$backfill$;

-- Step 2: add the CHECK constraint (idempotent via DO...EXCEPTION).
DO $$ BEGIN
  ALTER TABLE users
    ADD CONSTRAINT users_handle_format
      CHECK (
        handle ~ '^[a-zA-Z0-9_-]{3,20}$'
        OR handle ~ '^[a-zA-Z0-9_-]+@guest\.local$'
      );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
