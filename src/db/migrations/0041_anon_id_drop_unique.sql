-- Relax anon_id from UNIQUE to a plain lookup index.
--
-- 0037 made anon_id unique: one browser = one guest identity. That breaks
-- the legitimate shared-computer flow (two people on one browser can never
-- play under two handles - the second join dies on the unique violation)
-- and forces test harnesses into one-app-per-player contortions.
--
-- The actual security property - nobody can act as a handle bound to a
-- DIFFERENT pb_anon cookie, and real registered accounts are never
-- resolvable by handle - is enforced in the resolution code paths
-- (room-actions resolveUser/resolveCallerUserId, phases vote, submissions
-- matchAndUser, ws ensureGuestUser), not by this index. Multiple guest
-- rows may share one anon_id; each handle is still owned by exactly one
-- cookie.

DROP INDEX IF EXISTS users_anon_id_unique;

CREATE INDEX IF NOT EXISTS users_anon_id_idx
  ON users (anon_id)
  WHERE anon_id IS NOT NULL;
