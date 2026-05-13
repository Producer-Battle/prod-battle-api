-- End-to-end proof that schema migrations now flow through atlas in CI.
-- Stamps a comment on the public schema noting the tooling transition.
-- No structural change, no row touches, idempotent.

COMMENT ON SCHEMA public IS 'producer-battle: schema migrations managed by atlas (transitioned 0039)';
