-- Migration 0030: dedicated 'upload' phase between submit and vote.
--
-- The submit phase is now production-only (producers work in their DAW).
-- When it expires, matches transition to the new 2-minute 'upload' phase
-- which is the hard "you must upload now" deadline. After upload (or all
-- submissions in), match advances to vote.
--
-- Backwards-compatible: existing matches in 'submit' continue normally;
-- the tick worker just gains an extra hop before vote.

ALTER TYPE match_phase ADD VALUE IF NOT EXISTS 'upload' AFTER 'submit';
ALTER TYPE match_status ADD VALUE IF NOT EXISTS 'upload' AFTER 'submit';
