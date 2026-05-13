-- End-to-end proof that schema migrations now flow through atlas in CI.
-- Stamps documentation comments on a couple of tables (no structural
-- change, no row touches, idempotent). COMMENT ON SCHEMA requires
-- schema ownership; the app role only owns tables it created, so we
-- target tables instead.

COMMENT ON TABLE users IS 'producer + guest accounts; anon_id binds guests to the pb_anon cookie';
COMMENT ON TABLE submissions IS 'producer track submissions, one row per (match, user); audio_url + waveform_url are wasabi-hosted as of 0038';
