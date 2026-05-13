-- Bind guest user records to the pb_anon cookie. The cookie is HttpOnly,
-- server-generated on first request, unpredictable - so it can carry
-- guest identity safely. Without this column the only "credential" for a
-- guest is the handle string, which is public (visible on the leaderboard
-- and in chat) and trivially impersonable.
--
-- Nullable + unique: NULL for the existing user rows that pre-date this
-- migration; uniqueness prevents two users mapping to the same anon_id
-- once it's set. Application code resolves a guest by anon_id first, falls
-- back to handle only for the first-ever interaction (where it then
-- writes the binding).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS anon_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS users_anon_id_unique
  ON users (anon_id)
  WHERE anon_id IS NOT NULL;
