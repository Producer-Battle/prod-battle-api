// Tick worker: every 1s, polls `battle_phases WHERE transitions_at <= now()`
// with FOR UPDATE SKIP LOCKED, advances current_phase, publishes a
// `phase_change` event to Redis. Guarded by leader election (see leader.ts)
// so only one replica ticks at a time.
//
// Phase lifecycle: lobby -> submit -> vote -> results
// The 'reveal' phase was removed. Any in-flight match at status='reveal'
// is flushed forward to 'vote' on the next tick (one-shot migration path).
//
// Daily matches are NOT driven by battle_phases. Instead, a separate check
// (dailyRolloverCheck) runs on the same tick cadence and transitions any
// mode='daily' match whose daily_date < today from 'submit' to 'results'.

import { and, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { battlePhases, matches, votes } from '../db/schema.js';
import { SUBMIT_SECONDS_DEFAULT } from '../matchmaking/defaults.js';
import { nextPhase } from '../room/state.js';
import { VOTE_SECONDS_DEFAULT, computeVoteDuration, onEnterPhase } from '../room/transitions.js';
import { runAsLeader } from './leader.js';
import { publish } from './pubsub.js';

// Phase durations (seconds) for non-submit phases.
// 'vote' is computed dynamically (max of configured + audio sum + buffer);
// VOTE_SECONDS_DEFAULT is the floor used when no audio durations are known.
const PHASE_DURATION: Record<string, number> = {
  lobby: 0,
  submit: 300, // fallback - match.submitSeconds takes precedence
  vote: VOTE_SECONDS_DEFAULT,
  results: 0, // terminal - no next phase
};

async function tick(): Promise<void> {
  const d = db();
  // postgres-js doesn't auto-cast Date inside `sql` template literals - pass
  // an ISO string + an explicit ::timestamptz cast instead, or the driver
  // throws "Received an instance of Date" on every tick.
  const nowIso = new Date().toISOString();

  // Select all phases that are due to transition, locking rows for this replica only.
  // Also include any match stuck at 'reveal' (in-flight migration: flush to vote).
  const due = await d
    .select({
      matchId: battlePhases.matchId,
      currentPhase: battlePhases.currentPhase,
      submitSeconds: matches.submitSeconds,
      matchMode: matches.mode,
    })
    .from(battlePhases)
    .innerJoin(matches, sql`${matches.id} = ${battlePhases.matchId}`)
    .where(
      sql`(${battlePhases.transitionsAt} <= ${nowIso}::timestamptz
        OR ${battlePhases.currentPhase} = 'reveal'::match_phase)`,
    )
    .for('update', { skipLocked: true });

  for (const row of due) {
    const next = nextPhase(row.currentPhase as Parameters<typeof nextPhase>[0]);
    if (!next) {
      // Terminal phase - remove from battle_phases so we stop ticking it.
      await d.delete(battlePhases).where(sql`${battlePhases.matchId} = ${row.matchId}`);
      continue;
    }

    // When the vote phase times out, check if everyone voted.
    // maybeAdvanceAfterVote fires early when the threshold is met; reaching
    // this branch on the timer means some players didn't vote in time.
    // We discard the accrued votes so tallyResults assigns no winner.
    let voteOutcome: 'complete' | 'incomplete' = 'complete';
    if (row.currentPhase === 'vote' && next === 'results') {
      const outcomeRows = (await d.execute<{ seated: number; full: number }>(sql`
        WITH s AS (
          SELECT COUNT(*)::int AS n FROM match_players
           WHERE match_id = ${row.matchId} AND is_spectator = false
        ),
        voter_counts AS (
          SELECT v.voter_id, COUNT(*)::int AS votes_cast
            FROM votes v
           WHERE v.match_id = ${row.matchId}
           GROUP BY v.voter_id
        )
        SELECT (SELECT n FROM s)::int AS seated,
               (SELECT COUNT(*)::int FROM voter_counts
                 WHERE votes_cast >= GREATEST((SELECT n FROM s) - 1, 0)) AS full
      `)) as unknown as [{ seated: number; full: number }];
      const seated = outcomeRows[0]?.seated ?? 0;
      const full = outcomeRows[0]?.full ?? 0;
      if (seated > 0 && full < seated) {
        voteOutcome = 'incomplete';
        await d.delete(votes).where(sql`${votes.matchId} = ${row.matchId}`);
        console.log(`[tick] ${row.matchId}: vote incomplete (${full}/${seated}) - discarded`);
      }
    }

    // Determine how long the next phase lasts.
    let durationSeconds: number;
    if (next === 'submit') {
      durationSeconds =
        row.submitSeconds ??
        SUBMIT_SECONDS_DEFAULT[row.matchMode as keyof typeof SUBMIT_SECONDS_DEFAULT] ??
        300;
    } else if (next === 'vote') {
      // Vote duration = max(configured floor, sum of audio durations + buffer).
      // This ensures producers have time to listen to all tracks before voting.
      durationSeconds = await computeVoteDuration(row.matchId, VOTE_SECONDS_DEFAULT);
    } else {
      durationSeconds = PHASE_DURATION[next] ?? 60;
    }

    const transitionsAt =
      durationSeconds > 0
        ? new Date(Date.now() + durationSeconds * 1000)
        : new Date(Date.now() + 365 * 24 * 3600 * 1000); // far future if no auto-advance

    await d
      .update(battlePhases)
      .set({
        currentPhase: next,
        transitionsAt,
        updatedAt: new Date(),
      })
      .where(sql`${battlePhases.matchId} = ${row.matchId}`);

    await publish(`battle:${row.matchId}`, {
      type: 'phase_change',
      matchId: row.matchId,
      phase: next,
      transitionsAt: transitionsAt.getTime(),
      ...(row.currentPhase === 'vote' && next === 'results' ? { voteOutcome } : {}),
    });

    // Also update match status so REST reads reflect the current phase.
    await d
      .update(matches)
      .set({ status: next === 'results' ? 'results' : next })
      .where(sql`${matches.id} = ${row.matchId}`);

    // Domain side effects (vote tally etc.)
    await onEnterPhase(row.matchId, next);

    console.log(`[tick] ${row.matchId}: ${row.currentPhase} -> ${next}`);
  }
}

/**
 * Transition yesterday's (and older) daily matches from 'submit' to 'results'.
 * Runs on every tick but the SQL WHERE clause is a no-op on most ticks
 * (only fires when daily_date < today, i.e. at rollover).
 *
 * Voting remains open on results-status daily matches indefinitely - the vote
 * endpoint allows votes regardless of match status when mode='daily'.
 */
async function dailyRolloverCheck(): Promise<void> {
  const d = db();
  const today = new Date().toISOString().slice(0, 10);

  // Find daily matches stuck in 'submit' from previous days.
  const stale = await d.execute<{ id: string; room_code: string }>(
    sql`SELECT id, room_code
          FROM matches
         WHERE mode = 'daily'
           AND status = 'submit'
           AND daily_date < ${today}::date
         LIMIT 20`,
  );

  for (const row of stale as Array<{ id: string; room_code: string }>) {
    await d
      .update(matches)
      .set({ status: 'results', endedAt: new Date() })
      .where(sql`${matches.id} = ${row.id}`);

    await publish(`battle:${row.id}`, {
      type: 'phase_change',
      matchId: row.id,
      phase: 'results',
      transitionsAt: null,
    });

    console.log(`[tick] daily match ${row.id} (${row.room_code}) rolled over to results`);
  }
}

/**
 * Start the tick loop under leader election.
 * Returns a stop function that terminates the loop.
 */
export function startTickLoop(): () => void {
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  const stopLeader = runAsLeader('leader:tick', async () => {
    // Called once we become leader. Start the 1s tick interval.
    tickTimer = setInterval(() => {
      tick().catch((err: Error) => console.error('[tick] error:', err.message));
      dailyRolloverCheck().catch((err: Error) =>
        console.error('[tick] daily rollover error:', err.message),
      );
    }, 1000);
  });

  return () => {
    stopLeader();
    if (tickTimer) clearInterval(tickTimer);
  };
}
