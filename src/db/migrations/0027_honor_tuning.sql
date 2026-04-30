-- Migration 0027: honor tuning pass.
--
-- Two changes after running the recovery-time math:
--
-- 1) tournament_mid -10 -> -7. -10 felt hostile to alpha-stage players
--    who get a real-life interruption mid-tournament. -7 still hurts
--    (4 clean matches to recover after first-offence halving) but does
--    not put one bad day below the 70-honor tournament gate.
--
-- 2) tournament_lobby -3 -> -2 (consistency: ranked is -2, tournament
--    was -3 only because mid was bigger; smoother gradient now).
--
-- Ranked streak burst is implemented in code (honor/outcomes.ts now
-- fires the existing regenBurstPerCleanQpMatches config for ranked too)
-- so this migration only patches the penalties JSON.

UPDATE game_rules
   SET payload = jsonb_set(
                   jsonb_set(payload, '{penalties,tournament_mid}', '-7'::jsonb),
                   '{penalties,tournament_lobby}', '-2'::jsonb
                 ),
       updated_at = NOW()
 WHERE category = 'honor';
