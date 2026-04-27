// applyMatchOutcome - called when a match enters the 'results' phase.
// Walks match_players and:
//   - Sets completed_at on players who submitted
//   - Marks abandoned=true on players who didn't (or who already had
//     abandoned=true from a mid-match grace timeout)
//   - Computes per-player honor_delta from game_rules and writes it back
//   - Adjusts users.honor accordingly (clamped to [0, max])
//
// Called once per match at results entry. Idempotent: if a player already
// has honor_delta != 0 they're skipped (avoids double-applying penalties
// when the tick worker also marked them abandoned mid-match).
//
// Honor regen is "+1 per clean completion" capped at the configured max.
// A per-day rate limit is on the roadmap but not load-bearing today (the
// cap prevents abuse).

import { and, eq, gte, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { matchPlayers, matches, submissions, users } from '../db/schema.js';
import { getCategory } from '../game-rules/loader.js';
import type { ModeKey } from '../game-rules/types.js';

// Modes the API supports - mirror /matches.ts MODES.
const ABANDONABLE_MODES: ReadonlySet<string> = new Set([
  'quickplay',
  'ranked',
  'private',
  'flip',
  'daily',
  'tournament',
]);

function modeKeyFor(mode: string): ModeKey {
  if (ABANDONABLE_MODES.has(mode)) return mode as ModeKey;
  // Fallback to quickplay so we always have a valid penalty key.
  return 'quickplay';
}

export async function applyMatchOutcome(matchId: string): Promise<void> {
  const d = db();
  const honorRules = await getCategory('honor');

  // Pull the match to know its mode (and skip practice).
  const [m] = await d.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  if (!m) return;
  if (m.mode === 'practice') return; // solo, no outcomes

  const modeKey = modeKeyFor(m.mode);

  // Walk seated, non-spectator players. Skip ones we've already touched.
  const players = await d
    .select({
      userId: matchPlayers.userId,
      abandoned: matchPlayers.abandoned,
      honorDelta: matchPlayers.honorDelta,
      hasSubmission: sql<boolean>`EXISTS (
        SELECT 1 FROM submissions s
        WHERE s.match_id = ${matchId} AND s.user_id = ${matchPlayers.userId}
      )`,
    })
    .from(matchPlayers)
    .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.isSpectator, false)));

  for (const p of players) {
    if (p.honorDelta !== 0) continue; // already adjusted by mid-match grace

    if (p.hasSubmission && !p.abandoned) {
      // Clean completion: regen +1 (capped), record completed_at.
      await d
        .update(matchPlayers)
        .set({ completedAt: new Date(), honorDelta: honorRules.regenPerCleanDay })
        .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.userId, p.userId)));
      await d
        .update(users)
        .set({
          honor: sql`LEAST(${users.honor} + ${honorRules.regenPerCleanDay}, ${honorRules.max})`,
        })
        .where(eq(users.id, p.userId));
      // Achievements: lifetime match counts, genre mastery, tier promotion,
      // remix master line. Lazy import to avoid a cycle (achievements ->
      // tiers -> game-rules -> here).
      const { evaluateMatchEndAchievements } = await import('../achievements/award.js');
      await evaluateMatchEndAchievements(p.userId, m.mode).catch(() => {
        /* silent */
      });
    } else {
      // No submission and not yet flagged: late-stage abandon (failed to
      // submit). Apply the "_empty" penalty for this mode.
      const penaltyKey = `${modeKey}_empty` as const;
      const rawPenalty = honorRules.penalties[penaltyKey] ?? 0;
      const penalty = await applyFirstOffenceForgiveness(p.userId, rawPenalty, honorRules);

      await d
        .update(matchPlayers)
        .set({ abandoned: true, honorDelta: penalty })
        .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.userId, p.userId)));
      await d
        .update(users)
        .set({ honor: sql`GREATEST(${users.honor} + ${penalty}, 0)` })
        .where(eq(users.id, p.userId));
    }
  }
}

// First-offence forgiveness: if no honor change happened in the rolling
// window (default 30d), halve the penalty. Encourages occasional offenders
// to clean up without making chronic abandoners get off easy.
async function applyFirstOffenceForgiveness(
  userId: string,
  rawPenalty: number,
  honorRules: { firstOffenceWindowDays: number; firstOffenceMultiplier: number },
): Promise<number> {
  if (rawPenalty >= 0) return rawPenalty;
  const d = db();
  const cutoff = new Date(Date.now() - honorRules.firstOffenceWindowDays * 86400 * 1000);
  const recent = await d
    .select({ userId: matchPlayers.userId })
    .from(matchPlayers)
    .where(
      and(
        eq(matchPlayers.userId, userId),
        ne(matchPlayers.honorDelta, 0),
        isNotNull(matchPlayers.completedAt),
        gte(matchPlayers.completedAt, cutoff),
      ),
    )
    .limit(1);
  if (recent.length === 0) {
    return Math.round(rawPenalty * honorRules.firstOffenceMultiplier);
  }
  return rawPenalty;
}

// Called by the tick-worker grace-detector. Marks a single player as
// abandoned mid-match (still inside the submission window) and applies
// the "_mid" penalty. Idempotent via honorDelta != 0 check.
export async function markPlayerAbandoned(
  matchId: string,
  userId: string,
  matchMode: string,
): Promise<void> {
  const d = db();

  const [existing] = await d
    .select({ honorDelta: matchPlayers.honorDelta, abandoned: matchPlayers.abandoned })
    .from(matchPlayers)
    .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.userId, userId)))
    .limit(1);
  if (!existing || existing.honorDelta !== 0 || existing.abandoned) return;

  const modeKey = modeKeyFor(matchMode);
  const honorRules = await getCategory('honor');
  const penaltyKey = `${modeKey}_mid` as const;
  const rawPenalty = honorRules.penalties[penaltyKey] ?? 0;
  const penalty = await applyFirstOffenceForgiveness(userId, rawPenalty, honorRules);

  await d
    .update(matchPlayers)
    .set({ abandoned: true, honorDelta: penalty })
    .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.userId, userId)));
  await d
    .update(users)
    .set({ honor: sql`GREATEST(${users.honor} + ${penalty}, 0)` })
    .where(eq(users.id, userId));
}

// Submissions table re-export to keep the imports honest.
export { submissions };
