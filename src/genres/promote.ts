// Weekly genre promotion job.
//
// Promotes every genre that:
//   - has status='proposed'
//   - has voting_ends_at <= now()
//   - received at least PROMOTION_VOTE_THRESHOLD unique votes
// to status='active'. Any proposed genre whose window ended without hitting
// the threshold is archived instead.
//
// Called on a timer from src/realtime/tick.ts alongside the phase ticker.
// The job is safe to run concurrently across replicas — it's guarded by a
// single UPDATE with a WHERE clause on status+voting_ends_at, so the first
// replica to win the write closes the window and subsequent replicas see
// zero rows to update.

import { and, eq, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { genres } from '../db/schema.js';

/**
 * Minimum unique votes required to promote a proposed genre to public.
 * Tune this when the community is larger — 3 is intentionally low for MVP
 * so a small circle can self-seed the catalogue.
 */
export const PROMOTION_VOTE_THRESHOLD = 3;

export async function runGenrePromotionJob(): Promise<{
  promoted: number;
  archived: number;
}> {
  const d = db();
  const now = new Date();

  // Single statement:
  //   proposed + window-ended + ≥ threshold votes  → active
  //   proposed + window-ended + < threshold votes  → archived
  // Doing both in one SQL round trip avoids a race where a replica could
  // promote a genre moments before another archives it.
  const result = await d.execute<{ id: string; new_status: 'active' | 'archived' }>(sql`
    WITH decided AS (
      SELECT g.id,
             CASE
               WHEN COALESCE(vc.n, 0) >= ${PROMOTION_VOTE_THRESHOLD}
                 THEN 'active'::genre_status
               ELSE 'archived'::genre_status
             END AS new_status
        FROM genres g
        LEFT JOIN (
          SELECT genre_id, COUNT(*)::int AS n
            FROM genre_votes
           GROUP BY genre_id
        ) vc ON vc.genre_id = g.id
       WHERE g.status = 'proposed'
         AND g.voting_ends_at IS NOT NULL
         AND g.voting_ends_at <= ${now}
    )
    UPDATE genres
       SET status = decided.new_status,
           voting_ends_at = NULL
      FROM decided
     WHERE genres.id = decided.id
    RETURNING genres.id, decided.new_status AS new_status
  `);

  let promoted = 0;
  let archived = 0;
  for (const row of result) {
    if (row.new_status === 'active') promoted++;
    else archived++;
  }

  if (promoted + archived > 0) {
    console.log(`[genre-promote] promoted=${promoted} archived=${archived}`);
  }
  return { promoted, archived };
}

/**
 * Start a ticker that runs the promotion job on an interval. Returns a
 * stop function. Safe to call at module-load time from server.ts — errors
 * are logged and don't crash the process.
 */
export function startGenrePromotionLoop(intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    runGenrePromotionJob().catch((err: Error) => {
      console.error('[genre-promote] error:', err.message);
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

// Kept unused for now but imported above for drizzle type inference.
void and;
void eq;
void lte;
void genres;
