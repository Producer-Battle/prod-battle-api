-- Migration 0029: chromaprint fingerprinting columns on submissions.
--
-- fingerprint: raw 32-bit int array from fpcalc -raw -json. NULL until the
--   transcode callback runs fpcalc and stores the result.
-- fingerprint_duration_sec: track length reported by fpcalc.
-- dq_reason: populated when the submission is rejected post-transcode (e.g.
--   self-resubmit detected). NULL for accepted submissions.

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS fingerprint integer[],
  ADD COLUMN IF NOT EXISTS fingerprint_duration_sec real,
  ADD COLUMN IF NOT EXISTS dq_reason text;

-- Partial index: only rows with a fingerprint need fast lookup by user + age.
-- Covers the self-resubmit query: WHERE user_id = ? AND created_at > ? AND fingerprint IS NOT NULL.
CREATE INDEX IF NOT EXISTS submissions_user_fp_created
  ON submissions (user_id, created_at DESC)
  WHERE fingerprint IS NOT NULL;
