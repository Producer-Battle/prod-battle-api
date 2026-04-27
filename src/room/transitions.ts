// Phase transition side effects. Called by the tick worker each time a
// match advances (submit->vote->results). Also callable directly
// from submission / vote routes when all players finish early.

import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { and, asc, eq, sql } from 'drizzle-orm';
import { bucket, keyFromUrl, s3 } from '../audio/s3.js';
import { db } from '../db/client.js';
import { battlePhases, matches, submissions, votes } from '../db/schema.js';
import { publish } from '../realtime/pubsub.js';
import type { Phase } from './state.js';

// Default vote phase duration in seconds. The actual duration is
// max(VOTE_SECONDS_DEFAULT, sum_of_submission_durations + VOTE_LISTEN_BUFFER)
// so producers always have enough time to listen before voting.
export const VOTE_SECONDS_DEFAULT = 90;
const VOTE_LISTEN_BUFFER = 10; // seconds added on top of audio sum
const NULL_DURATION_FALLBACK = 30; // assumed duration when durationSec is NULL

/**
 * Recompute scores when a match ends: sum(vote.weight) per submission,
 * write to submissions.score + final_rank. Ranks 1..N, ties broken by
 * earliest created_at.
 *
 * Zero-vote cleanup: if EVERY submission has 0 votes (nobody voted at all),
 * we delete the submission rows and their S3 audio objects so the feed/
 * leaderboard stays clean. The match still transitions to 'results'; the
 * empty submissions list is the signal that no winner was recorded.
 */
async function tallyResults(matchId: string): Promise<void> {
  const d = db();

  // Collect scores keyed by submission.
  const rows = await d.execute<{
    submission_id: string;
    audio_url: string;
    score: string | number;
    tie_break: string;
  }>(
    sql`SELECT s.id AS submission_id,
               s.audio_url,
               COALESCE(SUM(v.weight), 0) AS score,
               s.created_at AS tie_break
          FROM submissions s
          LEFT JOIN votes v
            ON v.submission_id = s.id AND v.match_id = ${matchId}
         WHERE s.match_id = ${matchId}
         GROUP BY s.id, s.audio_url, s.created_at
         ORDER BY COALESCE(SUM(v.weight), 0) DESC, s.created_at ASC`,
  );

  // Zero-vote cleanup: if there are submissions but all have score=0, scrub them.
  const hasSubmissions = rows.length > 0;
  const allZeroVotes = hasSubmissions && rows.every((r) => Number(r.score) === 0);

  if (allZeroVotes) {
    // Delete S3 audio objects first (best-effort - do not fail the transition).
    for (const row of rows) {
      const key = keyFromUrl(row.audio_url);
      if (key) {
        try {
          await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
        } catch (err) {
          console.warn(`[transitions] failed to delete S3 object ${key}:`, (err as Error).message);
        }
      }
    }
    // Delete submission rows. submission_votes and submission_likes cascade.
    for (const row of rows) {
      await d.delete(submissions).where(eq(submissions.id, row.submission_id));
    }
    console.log(`[transitions] ${matchId}: all-zero vote - ${rows.length} submission(s) scrubbed`);
  } else {
    // Normal path: assign scores and ranks.
    let rank = 1;
    for (const row of rows) {
      await d
        .update(submissions)
        .set({ score: String(row.score), finalRank: rank })
        .where(eq(submissions.id, row.submission_id));
      rank++;
    }
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
 * Compute the vote phase duration for a match.
 * voteSeconds = max(configured_vote_seconds, sum_of_durations + buffer)
 * where sum uses NULL_DURATION_FALLBACK for submissions without durationSec.
 */
export async function computeVoteDuration(
  matchId: string,
  configuredVoteSeconds: number,
): Promise<number> {
  const d = db();
  const rows = await d.execute<{ duration_sec: number | null }>(
    sql`SELECT duration_sec FROM submissions WHERE match_id = ${matchId}`,
  );
  const audioSum = (rows as Array<{ duration_sec: number | null }>).reduce(
    (acc, r) => acc + (r.duration_sec ?? NULL_DURATION_FALLBACK),
    0,
  );
  return Math.max(configuredVoteSeconds, audioSum + VOTE_LISTEN_BUFFER);
}

/**
 * Called on every forward phase transition. The tick worker runs the DB
 * write + publishes `phase_change`; this hook handles domain side effects
 * (vote tally on results entry, etc.).
 */
export async function onEnterPhase(matchId: string, phase: Phase): Promise<void> {
  if (phase === 'results') {
    await tallyResults(matchId);
    // Honor accounting: regen for clean completers, abandon-penalty for
    // anyone who failed to submit. Must run AFTER tallyResults so the
    // submission set is final. Lazy-imported to avoid a cycle (honor
    // module imports schema which (transitively) imports back through
    // transitions.ts during compile).
    const { applyMatchOutcome } = await import('../honor/outcomes.js');
    await applyMatchOutcome(matchId).catch((err: Error) =>
      console.error('[outcome] applyMatchOutcome failed:', err.message),
    );
    // Ranked rating + LP + calibration update. No-op for non-ranked modes.
    const { applyRankedOutcome } = await import('../tiers/ranked-outcome.js');
    await applyRankedOutcome(matchId).catch((err: Error) =>
      console.error('[outcome] applyRankedOutcome failed:', err.message),
    );
  }
  // submit/vote currently need no side effects here.
}

/**
 * Force-advance a match to the next phase. Used when all players finish
 * early (everyone submitted, everyone voted) so the room doesn't wait for
 * the timer. Writes battle_phases + matches.status + publishes phase_change.
 * No-op if the phase is already past `from`.
 */
export async function advancePhase(
  matchId: string,
  from: Phase | 'reveal',
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
 * If so, short-circuit the submit timer and start the vote phase directly.
 * Vote duration is computed as max(configured, sum_of_durations + buffer).
 */
export async function maybeAdvanceAfterSubmission(matchId: string): Promise<void> {
  const d = db();

  const [{ seated, submitted }] = (await d.execute<{ seated: number; submitted: number }>(
    sql`SELECT
          (SELECT COUNT(*)::int FROM match_players WHERE match_id = ${matchId} AND is_spectator = false) AS seated,
          (SELECT COUNT(*)::int FROM submissions    WHERE match_id = ${matchId})                        AS submitted`,
  )) as unknown as [{ seated: number; submitted: number }];

  if (seated > 0 && submitted >= seated) {
    const voteDuration = await computeVoteDuration(matchId, VOTE_SECONDS_DEFAULT);
    await advancePhase(matchId, 'submit', 'vote', voteDuration);
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

// Keep drizzle helpers available for future per-phase side effects.
export const _unused = { and, asc };
