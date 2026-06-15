-- Marketing prep extras: make the flip loop + sample kit audible locally, and
-- seed tournaments so /tournaments isn't empty. Idempotent. Run with:
--   docker exec -i producer-battle-postgres-1 psql -U prodbattle -d prod_battle < scripts/seed-marketing-extra.sql

-- 1) Flip source -> a same-origin beat so the loop actually plays on camera.
UPDATE flip_sources SET url = 'http://localhost:5173/promo/beat3.wav';

-- 2) Pool sample-pack stems -> same-origin beats so the kit auditions locally
--    (the original localhost:9000 MinIO host isn't running in dev).
UPDATE sample_packs sp
SET samples = sub.s
FROM (
  SELECT id,
         jsonb_agg(
           jsonb_set(elem, '{url}',
             to_jsonb('http://localhost:5173/promo/beat' || (1 + ((ord - 1) % 8)) || '.wav'))
           ORDER BY ord
         ) AS s
  FROM sample_packs, jsonb_array_elements(samples) WITH ORDINALITY AS t(elem, ord)
  WHERE kind = 'pool'
  GROUP BY id
) sub
WHERE sp.id = sub.id AND sp.kind = 'pool';

-- 3) Upcoming tournament (registration open) + a full-looking entrant list.
INSERT INTO tournaments (name, genre_id, starts_at, registration_closes_at, status, max_entrants, bracket_enabled)
SELECT 'Phonk Throwdown #7', (SELECT id FROM genres WHERE slug = 'phonk'),
       now() + interval '2 days', now() + interval '20 hours', 'open', 16, true
WHERE NOT EXISTS (SELECT 1 FROM tournaments WHERE name = 'Phonk Throwdown #7');

INSERT INTO tournament_entries (tournament_id, user_id, registered_at)
SELECT t.id, u.id, now()
FROM tournaments t, users u
WHERE t.name = 'Phonk Throwdown #7'
  AND u.handle IN ('polystalgia','knxwnoise','mayflower','dj_kickrush','velour','ghostbyte','saint_lo')
ON CONFLICT DO NOTHING;

-- 4) A finished tournament with a crowned winner for the "Past" section.
INSERT INTO tournaments (name, genre_id, starts_at, registration_closes_at, status, max_entrants, bracket_enabled, winner_id, effective_size)
SELECT 'Amapiano Cup #3', (SELECT id FROM genres WHERE slug = 'amapiano'),
       now() - interval '7 days', now() - interval '8 days', 'finished', 16, true,
       (SELECT id FROM users WHERE handle = 'velour'), 8
WHERE NOT EXISTS (SELECT 1 FROM tournaments WHERE name = 'Amapiano Cup #3');

INSERT INTO tournament_entries (tournament_id, user_id, registered_at)
SELECT t.id, u.id, now() - interval '7 days'
FROM tournaments t, users u
WHERE t.name = 'Amapiano Cup #3'
  AND u.handle IN ('velour','polystalgia','knxwnoise','ghostbyte','mayflower','saint_lo','m0nolith','novaa')
ON CONFLICT DO NOTHING;
