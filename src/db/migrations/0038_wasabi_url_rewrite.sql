-- Migrate stored audio / asset URLs from Scaleway Object Storage to Wasabi.
-- Bucket name is preserved (prod-battle-audio) so only the host segment
-- changes. After this runs, every URL pointing at s3.fr-par.scw.cloud
-- resolves to the same key on Wasabi.
--
-- Safe to re-run: each UPDATE is guarded by a LIKE prefix, so rows already
-- pointing at Wasabi are not touched. To roll back, swap the REPLACE args.

BEGIN;

UPDATE users
   SET avatar_url = REPLACE(avatar_url,
        'https://s3.fr-par.scw.cloud/',
        'https://s3.eu-central-2.wasabisys.com/')
 WHERE avatar_url LIKE 'https://s3.fr-par.scw.cloud/%';

UPDATE submissions
   SET audio_url = REPLACE(audio_url,
        'https://s3.fr-par.scw.cloud/',
        'https://s3.eu-central-2.wasabisys.com/')
 WHERE audio_url LIKE 'https://s3.fr-par.scw.cloud/%';

UPDATE submissions
   SET waveform_url = REPLACE(waveform_url,
        'https://s3.fr-par.scw.cloud/',
        'https://s3.eu-central-2.wasabisys.com/')
 WHERE waveform_url LIKE 'https://s3.fr-par.scw.cloud/%';

UPDATE tournament_showcase_submissions
   SET audio_url = REPLACE(audio_url,
        'https://s3.fr-par.scw.cloud/',
        'https://s3.eu-central-2.wasabisys.com/')
 WHERE audio_url LIKE 'https://s3.fr-par.scw.cloud/%';

UPDATE sample_packs
   SET zip_url = REPLACE(zip_url,
        'https://s3.fr-par.scw.cloud/',
        'https://s3.eu-central-2.wasabisys.com/')
 WHERE zip_url LIKE 'https://s3.fr-par.scw.cloud/%';

UPDATE flip_sources
   SET url = REPLACE(url,
        'https://s3.fr-par.scw.cloud/',
        'https://s3.eu-central-2.wasabisys.com/')
 WHERE url LIKE 'https://s3.fr-par.scw.cloud/%';

COMMIT;
