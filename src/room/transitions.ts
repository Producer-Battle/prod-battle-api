// Phase transition side effects. Called by the tick worker each time a
// match advances (submit→reveal→vote→results). Also callable directly
// from submission / vote routes when all players finish early.

import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { battlePhases, matches, submissions, votes } from '../db/schema.js';
import { publish } from '../realtime/pubsub.js';
import type { Phase } from './state.js';

// Seconds each phase lasts when moving through it. submit is per-match
// (matches.submit_seconds overrides); the others are fixed defaults for now.
export const REVEAL_SECONDS = 60;
export const VOTE_SECONDS = 90;

/**
 * Recompute scores when a match ends: sum(vote.weight) per submission,
 * write to submissions.score + final_rank. Ranks 1..N, ties broken by
 * earliest created_at.
 */
async function tallyResults(matchId: string): Promise<void> {
  const d = db();

  // Collect scores keyed by submission.
  const rows = await d.execute<{
    submission_id: string;
    score: string | number;
    tie_break: string;
  }>(
    sql`SELECT s.id AS submission_id,
               COALESCE(SUM(v.weight), 0) AS score,
               s.created_at AS tie_break
          FROM submissions s
          LEFT JOIN votes v
            ON v.submission_id = s.id AND v.match_id = ${matchId}
         WHERE s.match_id = ${matchId}
         GROUP BY s.id, s.created_at
         ORDER BY COALESCE(SUM(v.weight), 0) DESC, s.created_at ASC`,
  );

  let rank = 1;
  for (const row of rows) {
    await d
      .update(submissions)
      .set({ score: String(row.score), finalRank: rank })
      .where(eq(submissions.id, row.submission_id));
    rank++;
  }

  // Flip match status + publish final results event with revealed identities.
  await d
    .update(matches)
    .set({ status: 'results', endedAt: new Date() })
    .where(eq(matches.id, matchId));

  const results = await d.execute<{
    submission_id: string;
    user_handle: string;
    title: string | null;
    audio_url: string;
    score: number;
    final_rank: number;
  }>(
    sql`SELECT s.id AS submission_id, u.handle AS user_handle, s.title,
               s.audio_url, s.score, s.final_rank
          FROM submissions s
          JOIN users u ON u.id = s.user_id
         WHERE s.match_id = ${matchId}
         ORDER BY s.final_rank ASC`,
  );

  await publish(`battle:${matchId}`, {
    type: 'results',
    matchId,
    results: results.map((r) => ({
      submissionId: r.submission_id,
      handle: r.user_handle,
      title: r.title,
      audioUrl: r.audio_url,
      score: Number(r.score),
      rank: r.final_rank,
    })),
  });
}

/**
 * Called on every forward phase transition. The tick worker runs the DB
 * write + publishes `phase_change`; this hook handles domain side effects
 * (vote tally on results entry, etc.).
 */
export async function onEnterPhase(matchId: string, phase: Phase): Promise<void> {
  if (phase === 'results') {
    await tallyResults(matchId);
  }
  // submit/reveal/vote currently need no side effects here.
}

/**
 * Force-advance a match to the next phase. Used when all players finish
 * early (everyone submitted, everyone voted) so the room doesn't wait for
 * the timer. Writes battle_phases + matches.status + publishes phase_change.
 * No-op if the phase is already past `from`.
 */
export async function advancePhase(
  matchId: string,
  from: Phase,
  to: Phase,
  durationSec: number,
): Promise<boolean> {
  const d = db();
  const [bp] = await d
    .select()
    .from(battlePhases)
    .where(eq(battlePhases.matchId, matchId))
    .limit(1);
  if (!bp || bp.currentPhase !== from) return false;

  const transitionsAt = new Date(Date.now() + durationSec * 1000);

  await d
    .update(battlePhases)
    .set({ currentPhase: to, transitionsAt, updatedAt: new Date() })
    .where(eq(battlePhases.matchId, matchId));

  await d
    .update(matches)
    .set({ status: to === 'results' ? 'results' : to })
    .where(eq(matches.id, matchId));

  await publish(`battle:${matchId}`, {
    type: 'phase_change',
    matchId,
    phase: to,
    transitionsAt: transitionsAt.getTime(),
  });

  await onEnterPhase(matchId, to);
  return true;
}

/**
 * When a submission lands, check if every seated player has submitted.
 * If so, short-circuit the submit timer and start the reveal.
 */
export async function maybeAdvanceAfterSubmission(matchId: string): Promise<void> {
  const d = db();

  const [{ seated, submitted }] = (await d.execute<{ seated: number; submitted: number }>(
    sql`SELECT
          (SELECT COUNT(*)::int FROM match_players WHERE match_id = ${matchId} AND is_spectator = false) AS seated,
          (SELECT COUNT(*)::int FROM submissions    WHERE match_id = ${matchId})                        AS submitted`,
  )) as unknown as [{ seated: number; submitted: number }];

  if (seated > 0 && submitted >= seated) {
    await advancePhase(matchId, 'submit', 'reveal', REVEAL_SECONDS);
  }
}

/**
 * When a vote lands, check if every seated player has voted on every
 * non-self submission - if so, close the vote window and tally results.
 */
export async function maybeAdvanceAfterVote(matchId: string): Promise<void> {
  const d = db();

  // Votes a player is expected to cast = (seated - 1), one per other
  // submission. Once every voter has that many rows we're done.
  const row = (
    await d.execute<{ seated: number; fully_voted_count: number }>(
      sql`WITH s AS (
          SELECT COUNT(*)::int AS n
            FROM match_players
           WHERE match_id = ${matchId} AND is_spectator = false
        ),
        voter_counts AS (
          SELECT v.voter_id, COUNT(*)::int AS votes_cast
            FROM votes v
           WHERE v.match_id = ${matchId}
           GROUP BY v.voter_id
        )
        SELECT (SELECT n FROM s) AS seated,
               (SELECT COUNT(*)::int FROM voter_counts
                 WHERE votes_cast >= GREATEST((SELECT n FROM s) - 1, 0)) AS fully_voted_count`,
    )
  )[0] as { seated: number; fully_voted_count: number };

  if (row.seated > 0 && row.fully_voted_count >= row.seated) {
    await advancePhase(matchId, 'vote', 'results', 0);
  }
}

// Suppress unused import warnings - drizzle helpers stay available for
// future per-phase side effects (e.g. reveal ordering).
export const _unused = { and, asc };
