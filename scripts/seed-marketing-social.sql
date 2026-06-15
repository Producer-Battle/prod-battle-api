-- Marketing demo data for the A&R + friends layer: a few A&R scouts, picks on
-- winning tracks (feeds the "A&R's Choice" badge + Most Scouted board), a
-- couple of open briefs, and accepted friend connections. Idempotent-ish.

-- 1) A&R scout accounts (with avatars).
INSERT INTO users (handle, email, email_verified, role, avatar_url)
VALUES
  ('scout_kai', 'scout_kai@demo.local', true, 'ar', 'https://api.dicebear.com/9.x/thumbs/png?seed=scout_kai&size=240'),
  ('scout_mara', 'scout_mara@demo.local', true, 'ar', 'https://api.dicebear.com/9.x/thumbs/png?seed=scout_mara&size=240'),
  ('scout_dev', 'scout_dev@demo.local', true, 'ar', 'https://api.dicebear.com/9.x/thumbs/png?seed=scout_dev&size=240')
ON CONFLICT (handle) DO UPDATE SET role = 'ar';

-- 2) A&R picks: each scout picks several public winning tracks. Distinct
--    scouts per track drive the Most-Scouted "arScouts" count.
INSERT INTO ar_picks (ar_user_id, submission_id, score, cosign, note)
SELECT sc.id, s.id,
       4 + (abs(hashtext(sc.handle || s.id::text)) % 2),                 -- 4 or 5
       (abs(hashtext(sc.handle || s.id::text)) % 3 = 0),                  -- ~1/3 cosigned
       'Loved the sound design.'
FROM (SELECT id, handle FROM users WHERE handle IN ('scout_kai','scout_mara','scout_dev')) sc
CROSS JOIN LATERAL (
  SELECT s.id FROM submissions s
   WHERE s.is_public = true AND s.final_rank = 1
   ORDER BY s.created_at DESC
   LIMIT 6
) s
ON CONFLICT (ar_user_id, submission_id) DO NOTHING;

-- 3) Open briefs posted by a scout.
INSERT INTO ar_briefs (ar_user_id, title, description, genre_id, bpm_hint, reward, deadline, status)
SELECT (SELECT id FROM users WHERE handle = 'scout_kai'),
       'Dark drift phonk, cowbell-forward',
       'Need a moody drift phonk beat - heavy 808s, cowbell lead, 130-150 BPM. Winner gets a feature on our next playlist.',
       (SELECT id FROM genres WHERE slug = 'phonk'),
       '130-150 BPM', 'Playlist feature', now() + interval '6 days', 'open'
WHERE NOT EXISTS (SELECT 1 FROM ar_briefs WHERE title = 'Dark drift phonk, cowbell-forward');

INSERT INTO ar_briefs (ar_user_id, title, description, genre_id, bpm_hint, reward, deadline, status)
SELECT (SELECT id FROM users WHERE handle = 'scout_mara'),
       'Amapiano log-drum roller',
       'Looking for a rolling amapiano groove with warm log drums and space for vocals. Top pick gets a studio session.',
       (SELECT id FROM genres WHERE slug = 'amapiano'),
       '110-115 BPM', 'Studio session', now() + interval '4 days', 'open'
WHERE NOT EXISTS (SELECT 1 FROM ar_briefs WHERE title = 'Amapiano log-drum roller');

-- 4) Accepted friend connections among demo producers.
INSERT INTO connections (requester_id, addressee_id, status, responded_at)
SELECT a.id, b.id, 'accepted', now()
FROM users a, users b
WHERE (a.handle, b.handle) IN (
  ('polystalgia','knxwnoise'),
  ('polystalgia','mayflower'),
  ('velour','ghostbyte'),
  ('knxwnoise','dj_kickrush')
)
ON CONFLICT (requester_id, addressee_id) DO NOTHING;
