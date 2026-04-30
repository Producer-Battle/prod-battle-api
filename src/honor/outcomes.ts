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

// Per-mode default no-vote penalty (when no admin override is in game_rules).
// Small enough to be forgiving on first offence (halved by the existing
// forgiveness ladder) but big enough that habitual ghost-voters slide.
const NO_VOTE_PENALTY_FALLBACK: Record<ModeKey, number> = {
  quickplay: -2,
  ranked: -3,
  private: -1,
  flip: -2,
  // Daily is async with up to 20 submissions; we only require ONE vote
  // (see fullVoteThresholdFor below), so the penalty is gentle.
  daily: -1,
  tournament: -3,
};

// How many other-submission votes count as "fully voted" per mode. For
// most modes a voter is expected to score every non-self entry. Daily is
// async with up to 20 tracks; asking for all 19 is unreasonable, so we
// drop the threshold to "cast at least one vote".
function fullVoteThresholdFor(mode: string, votableCount: number): number {
  if (mode === 'daily') return votableCount === 0 ? 0 : 1;
  return votableCount;
}

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

  // Walk seated, non-spectator players. Per-row votable = how many other
  // submissions exist that aren't this player's own. Voter is "fully
  // voted" if they cast votes on every one of them. Single raw query so
  // both correlated subqueries see the outer match_players row reliably.
  type PlayerRow = {
    user_id: string;
    abandoned: boolean;
    honor_delta: number;
    has_submission: boolean;
    votes_cast: number;
    votable_count: number;
  };
  const players = (
    (await d.execute<PlayerRow>(
      sql`SELECT mp.user_id,
                mp.abandoned,
                mp.honor_delta,
                EXISTS (SELECT 1 FROM submissions s
                         WHERE s.match_id = ${matchId} AND s.user_id = mp.user_id) AS has_submission,
                COALESCE((SELECT COUNT(*)::int FROM votes v
                           WHERE v.match_id = ${matchId} AND v.voter_id = mp.user_id), 0) AS votes_cast,
                (SELECT COUNT(*)::int FROM submissions s
                  WHERE s.match_id = ${matchId} AND s.user_id != mp.user_id) AS votable_count
           FROM match_players mp
          WHERE mp.match_id = ${matchId} AND mp.is_spectator = false`,
    )) as PlayerRow[]
  ).map((r) => ({
    userId: r.user_id,
    abandoned: r.abandoned,
    honorDelta: Number(r.honor_delta),
    hasSubmission: r.has_submission,
    votesCast: Number(r.votes_cast),
    votableCount: Number(r.votable_count),
  }));

  for (const p of players) {
    if (p.honorDelta !== 0) continue; // already adjusted by mid-match grace

    const votable = p.votableCount;
    const threshold = fullVoteThresholdFor(m.mode, votable);
    const fullyVoted = threshold === 0 || p.votesCast >= threshold;

    if (p.hasSubmission && !p.abandoned && !fullyVoted) {
      // Submitted but ghosted on the vote phase. Small honor hit so the
      // soft-tally policy (we keep partial votes) does not become a free
      // ride. Reuses the first-offence forgiveness ladder.
      const penaltyKey = `${modeKey}_no_vote` as const;
      const rawPenalty = honorRules.penalties[penaltyKey] ?? NO_VOTE_PENALTY_FALLBACK[modeKey];
      const penalty = await applyFirstOffenceForgiveness(p.userId, rawPenalty, honorRules);

      await d
        .update(matchPlayers)
        .set({ honorDelta: penalty })
        .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.userId, p.userId)));
      await d
        .update(users)
        .set({ honor: sql`GREATEST(${users.honor} + ${penalty}, 0)` })
        .where(eq(users.id, p.userId));
      continue;
    }

    if (p.hasSubmission && !p.abandoned) {
      // Clean completion: regen +1 (capped), record completed_at.
      // Quickplay completions also count toward a streak burst: every N
      // clean QP matches in a row triggers an extra +5 (configurable).
      // The burst is the rehab lane for low-honor players to recover
      // faster than +1/match.
      let regen = honorRules.regenPerCleanDay;
      let bonusReason: string | null = null;
      if (m.mode === 'quickplay') {
        const burst = honorRules.regenBurstPerCleanQpMatches;
        const recent = await d.execute<{
          mode: string;
          abandoned: boolean;
        }>(
          sql`SELECT m.mode, mp.abandoned
                FROM match_players mp
                JOIN matches m ON m.id = mp.match_id
               WHERE mp.user_id = ${p.userId}
                 AND mp.completed_at IS NOT NULL
               ORDER BY mp.completed_at DESC
               LIMIT ${burst.matches}`,
        );
        const arr = recent as Array<{ mode: string; abandoned: boolean }>;
        // Including the just-completed match (which we're about to write
        // completed_at for - so it's not in the query yet, but we know
        // it's a clean QP). Need (burst.matches - 1) PRIOR clean QPs.
        const priorCleanQp = arr.filter((r) => r.mode === 'quickplay' && !r.abandoned).length;
        if (priorCleanQp >= burst.matches - 1) {
          regen += burst.amount;
          bonusReason = `+${burst.amount} burst after ${burst.matches} clean QP`;
        }
      }
      await d
        .update(matchPlayers)
        .set({ completedAt: new Date(), honorDelta: regen })
        .where(and(eq(matchPlayers.matchId, matchId), eq(matchPlayers.userId, p.userId)));
      await d
        .update(users)
        .set({
          honor: sql`LEAST(${users.honor} + ${regen}, ${honorRules.max})`,
        })
        .where(eq(users.id, p.userId));
      if (bonusReason) console.log(`[honor] ${p.userId} ${bonusReason}`);
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
