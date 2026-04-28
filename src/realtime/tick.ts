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

import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { sql } from 'drizzle-orm';
import { bucket, keyFromUrl, s3 } from '../audio/s3.js';
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

// Throttle: only run the sweeper once every 30 seconds even though the
// tick fires every 1s. Each rule is an indexed UPDATE/DELETE but there is
// no point running them more than this.
let lastSweepAt = 0;

/**
 * Cancel stale matches, hard-delete old cancelled matches, and prune
 * orphaned uploaded sample packs (failed uploads that left zero samples).
 *
 * Runs on the 1s tick cadence but is gated to execute at most once every
 * 30 seconds via the module-level `lastSweepAt` timestamp.
 */
export async function staleMatchSweep(): Promise<void> {
  const now = Date.now();
  if (now - lastSweepAt < 30_000) return;
  lastSweepAt = now;

  const d = db();

  // Rule 1: empty lobby - no seated players after 10 minutes.
  const emptyLobby = await d.execute<{ rowcount: number }>(
    sql`WITH cancelled AS (
          UPDATE matches
             SET status = 'cancelled', ended_at = now()
           WHERE status = 'lobby'
             AND mode   != 'daily'
             AND created_at < now() - interval '10 minutes'
             AND NOT EXISTS (
                   SELECT 1 FROM match_players mp
                    WHERE mp.match_id = matches.id
                      AND mp.is_spectator = false
                 )
           RETURNING id
        )
        SELECT COUNT(*)::int AS rowcount FROM cancelled`,
  );
  const emptyLobbyCount = Number((emptyLobby as Array<{ rowcount: number }>)[0]?.rowcount ?? 0);
  if (emptyLobbyCount > 0) {
    console.log(`[sweep] empty-lobby cancelled: ${emptyLobbyCount}`);
  }

  // Rule 2: lobby that was started (players joined) but never reached a
  // battle_phase after 30 minutes.
  const abandonedLobby = await d.execute<{ rowcount: number }>(
    sql`WITH cancelled AS (
          UPDATE matches
             SET status = 'cancelled', ended_at = now()
           WHERE status = 'lobby'
             AND mode   != 'daily'
             AND created_at < now() - interval '30 minutes'
             AND NOT EXISTS (
                   SELECT 1 FROM battle_phases bp
                    WHERE bp.match_id = matches.id
                 )
           RETURNING id
        )
        SELECT COUNT(*)::int AS rowcount FROM cancelled`,
  );
  const abandonedLobbyCount = Number(
    (abandonedLobby as Array<{ rowcount: number }>)[0]?.rowcount ?? 0,
  );
  if (abandonedLobbyCount > 0) {
    console.log(`[sweep] started-but-abandoned cancelled: ${abandonedLobbyCount}`);
  }

  // Rule 3: submit phase with no submissions and timer expired by >5 minutes.
  const staleSumit = await d.execute<{ rowcount: number }>(
    sql`WITH cancelled AS (
          UPDATE matches
             SET status = 'cancelled', ended_at = now()
           WHERE status = 'submit'
             AND mode   != 'daily'
             AND EXISTS (
                   SELECT 1 FROM battle_phases bp
                    WHERE bp.match_id = matches.id
                      AND bp.current_phase = 'submit'
                      AND bp.transitions_at < now() - interval '5 minutes'
                 )
             AND NOT EXISTS (
                   SELECT 1 FROM submissions s
                    WHERE s.match_id = matches.id
                 )
           RETURNING id
        )
        SELECT COUNT(*)::int AS rowcount FROM cancelled`,
  );
  const staleSubmitCount = Number((staleSumit as Array<{ rowcount: number }>)[0]?.rowcount ?? 0);
  if (staleSubmitCount > 0) {
    console.log(`[sweep] submit-with-no-submissions cancelled: ${staleSubmitCount}`);
  }

  // Rule 4: hard-delete cancelled matches older than 7 days.
  // Collect S3 keys from cascading submissions first (best-effort).
  const oldCancelled = await d.execute<{ id: string; audio_url: string }>(
    sql`SELECT m.id, s.audio_url
          FROM matches m
          JOIN submissions s ON s.match_id = m.id
         WHERE m.status = 'cancelled'
           AND (m.ended_at IS NULL OR m.ended_at < now() - interval '7 days')
           AND m.created_at < now() - interval '7 days'`,
  );
  const keysToDelete = (oldCancelled as Array<{ id: string; audio_url: string }>)
    .map((r) => keyFromUrl(r.audio_url))
    .filter((k): k is string => k !== null);

  const deletedMatches = await d.execute<{ rowcount: number }>(
    sql`WITH deleted AS (
          DELETE FROM matches
           WHERE status = 'cancelled'
             AND (ended_at IS NULL OR ended_at < now() - interval '7 days')
             AND created_at < now() - interval '7 days'
           RETURNING id
        )
        SELECT COUNT(*)::int AS rowcount FROM deleted`,
  );
  const deletedMatchCount = Number(
    (deletedMatches as Array<{ rowcount: number }>)[0]?.rowcount ?? 0,
  );
  if (deletedMatchCount > 0) {
    console.log(`[sweep] old-cancelled matches deleted: ${deletedMatchCount}`);
  }

  // Best-effort S3 cleanup for the collected keys.
  for (const key of keysToDelete) {
    try {
      await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
    } catch (err) {
      console.warn(`[sweep] failed to delete S3 object ${key}:`, (err as Error).message);
    }
  }

  // Rule 5: orphaned uploaded packs with zero samples older than 24 hours.
  const orphanedPacks = await d.execute<{ rowcount: number }>(
    sql`WITH deleted AS (
          DELETE FROM sample_packs
           WHERE kind = 'uploaded'
             AND jsonb_array_length(samples) = 0
             AND created_at < now() - interval '24 hours'
           RETURNING id
        )
        SELECT COUNT(*)::int AS rowcount FROM deleted`,
  );
  const orphanedPackCount = Number(
    (orphanedPacks as Array<{ rowcount: number }>)[0]?.rowcount ?? 0,
  );
  if (orphanedPackCount > 0) {
    console.log(`[sweep] orphaned uploaded packs deleted: ${orphanedPackCount}`);
  }

  // Rule 6: delete free-tier submissions whose expires_at has passed.
  // Collect audio URLs first so we can best-effort remove the S3 objects.
  const expiredSubs = await d.execute<{ id: string; audio_url: string }>(
    sql`SELECT id, audio_url FROM submissions
         WHERE expires_at IS NOT NULL AND expires_at < now()`,
  );
  const expiredSubRows = expiredSubs as Array<{ id: string; audio_url: string }>;
  if (expiredSubRows.length > 0) {
    const expiredSubKeys = expiredSubRows
      .map((r) => keyFromUrl(r.audio_url))
      .filter((k): k is string => k !== null);

    const deletedSubs = await d.execute<{ rowcount: number }>(
      sql`WITH deleted AS (
            DELETE FROM submissions
             WHERE expires_at IS NOT NULL AND expires_at < now()
             RETURNING id
          )
          SELECT COUNT(*)::int AS rowcount FROM deleted`,
    );
    const deletedSubCount = Number((deletedSubs as Array<{ rowcount: number }>)[0]?.rowcount ?? 0);
    if (deletedSubCount > 0) {
      console.log(`[sweep] expired free-tier submissions deleted: ${deletedSubCount}`);
    }

    // Best-effort S3 cleanup for the audio files.
    for (const key of expiredSubKeys) {
      try {
        await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
      } catch (err) {
        console.warn(`[sweep] failed to delete S3 object ${key}:`, (err as Error).message);
      }
    }
  }

  // Rule 7: hard-delete users whose 14-day delete grace has expired.
  // Anonymise the handle first so opponent match histories keep a stable
  // pointer (FK is ON DELETE SET NULL on most opponent-facing columns).
  // The cascade clears submissions, match_players, achievements, etc.
  const expiredDeletes = await d.execute<{ id: string; handle: string }>(
    sql`SELECT id, handle FROM users
         WHERE status = 'archived'
           AND deleted_at IS NOT NULL
           AND deleted_at < now() - interval '14 days'
         LIMIT 50`,
  );
  for (const row of expiredDeletes as Array<{ id: string; handle: string }>) {
    // Random 8-char sentinel handle so the unique index doesn't collide
    // when the same user re-signs up with their old handle.
    const sentinel = `deleted-${Math.random().toString(36).slice(2, 10)}`;
    await d.execute(
      sql`UPDATE users SET handle = ${sentinel}, email = ${sentinel} || '@deleted.local', status = 'deleted' WHERE id = ${row.id}`,
    );
    await d.execute(sql`DELETE FROM users WHERE id = ${row.id}`);
    console.log(`[sweep] hard-deleted user ${row.id} (was @${row.handle})`);
  }
}

// Throttle the grace scan to once per 30s. The 1s tick is overkill for
// abandon detection and one slow scan starves the rest of the loop.
let lastGraceAt = 0;

// Daily / weekly champion auto-award. Champions are the top-voted
// submitter on the trailing UTC day / week. Computed via a single
// scoring SQL pass and idempotently inserted into achievements.
let lastChampionScanAt = 0;

async function championScan(): Promise<void> {
  const now = Date.now();
  // Run every 5 min. Awards are gated by ON CONFLICT DO NOTHING so a
  // re-run is harmless. Intentionally not a per-day cron because we
  // don't want the worker dependent on system cron schedulers.
  if (now - lastChampionScanAt < 300_000) return;
  lastChampionScanAt = now;

  const d = db();

  // Daily Champion: top-scoring submission for any 'daily' match whose
  // results phase is in the trailing 30 days. We look back wider than
  // a day to also award champions for daily matches that were voted
  // on later (daily voting stays open indefinitely).
  const dailyTops = await d.execute<{ user_id: string; daily_date: string }>(
    sql`SELECT DISTINCT ON (m.daily_date) s.user_id, m.daily_date::text
          FROM submissions s
          JOIN matches m ON m.id = s.match_id
         WHERE m.mode = 'daily'
           AND m.daily_date IS NOT NULL
           AND m.daily_date >= (now() - interval '30 days')::date
         ORDER BY m.daily_date DESC, s.score DESC`,
  );
  const dailyArr = dailyTops as Array<{ user_id: string; daily_date: string }>;
  for (const row of dailyArr) {
    await d.execute(
      sql`INSERT INTO achievements (user_id, achievement_key) VALUES (${row.user_id}, 'daily_champion') ON CONFLICT DO NOTHING`,
    );
  }

  // Weekly Pick: highest-scored submission of the trailing 7 days
  // across ALL match modes. One winner per ISO week.
  const weeklyTop = await d.execute<{ user_id: string }>(
    sql`SELECT s.user_id
          FROM submissions s
          JOIN matches m ON m.id = s.match_id
         WHERE m.ended_at >= now() - interval '7 days'
           AND m.ended_at IS NOT NULL
         ORDER BY s.score DESC
         LIMIT 1`,
  );
  const weekly = weeklyTop as Array<{ user_id: string }>;
  if (weekly.length > 0 && weekly[0]) {
    await d.execute(
      sql`INSERT INTO achievements (user_id, achievement_key) VALUES (${weekly[0].user_id}, 'weekly_pick') ON CONFLICT DO NOTHING`,
    );
  }
}

// Soft-reset season rollover. When the active season changes, copy each
// player's last-season rating into the new season at softResetPercent of
// the old value, floored at the previous tier's entry minus one
// sub-division. Idempotent via existence check on the new season's row.
let lastSoftResetAt = 0;

async function seasonSoftResetScan(): Promise<void> {
  const now = Date.now();
  if (now - lastSoftResetAt < 600_000) return; // every 10 minutes
  lastSoftResetAt = now;

  const d = db();
  const { activeSeason, getCategory } = await import('../game-rules/loader.js');
  const tierRules = await getCategory('tiers');
  const current = await activeSeason().catch(() => null);
  if (!current) return;

  // For each user with a rankings row in any season EXCEPT the current
  // active one, copy them into the active season at the soft-reset value
  // - but only if they don't already have an active-season row (else
  // we'd overwrite their in-progress rating).
  const carryovers = await d.execute<{
    user_id: string;
    genre_id: string;
    last_rating: string;
  }>(
    sql`WITH latest AS (
          SELECT DISTINCT ON (r.user_id, r.genre_id)
                 r.user_id, r.genre_id, r.glicko_rating::text AS last_rating, s.ends_at
            FROM rankings r
            JOIN seasons s ON s.id = r.season_id
           WHERE r.season_id != ${current.id}
             AND s.ends_at < now()
           ORDER BY r.user_id, r.genre_id, s.ends_at DESC
        )
        SELECT user_id, genre_id, last_rating FROM latest
         WHERE NOT EXISTS (
                 SELECT 1 FROM rankings r2
                  WHERE r2.user_id = latest.user_id
                    AND r2.genre_id = latest.genre_id
                    AND r2.season_id = ${current.id}
               )
         LIMIT 200`,
  );
  const arr = carryovers as Array<{ user_id: string; genre_id: string; last_rating: string }>;
  if (arr.length === 0) return;

  for (const row of arr) {
    const oldRating = Number(row.last_rating);
    const reset = Math.round(oldRating * tierRules.softResetPercent);
    // Floor: find the boundary the old rating sat in, then drop to the
    // PREVIOUS tier's entry (so a Master player resets to high
    // Diamond, not bronze).
    let floor = 0;
    const oldBoundary = tierRules.boundaries.find(
      (b) => oldRating >= b.min && (b.max === null || oldRating < b.max),
    );
    if (oldBoundary) {
      const oldIdx = tierRules.boundaries.indexOf(oldBoundary);
      // softResetFloorOffset is typically -1 = "drop one tier minimum"
      const targetIdx = Math.max(0, oldIdx + tierRules.softResetFloorOffset);
      const targetBoundary = tierRules.boundaries[targetIdx];
      floor = targetBoundary?.min ?? 0;
    }
    const finalRating = Math.max(reset, floor);
    await d.execute(
      sql`INSERT INTO rankings (user_id, genre_id, season_id, glicko_rating)
            VALUES (${row.user_id}, ${row.genre_id}, ${current.id}, ${String(finalRating)})
          ON CONFLICT DO NOTHING`,
    );
    console.log(
      `[soft-reset] user=${row.user_id} genre=${row.genre_id} ${oldRating} -> ${finalRating}`,
    );
  }
}

/**
 * Scan active matches for players whose Redis presence key has expired.
 * Mark them abandoned via markPlayerAbandoned which applies the mode's
 * `_mid` honor penalty and is idempotent (won't double-apply).
 *
 * Active matches = matches.status IN ('lobby','submit','vote'). Spectators
 * and players already flagged abandoned are skipped at the outer query.
 */
async function graceCheck(): Promise<void> {
  const now = Date.now();
  if (now - lastGraceAt < 30_000) return;
  lastGraceAt = now;

  const d = db();
  const rows = await d.execute<{
    match_id: string;
    user_id: string;
    mode: string;
  }>(
    sql`SELECT mp.match_id, mp.user_id, m.mode
          FROM match_players mp
          JOIN matches m ON m.id = mp.match_id
         WHERE m.status IN ('lobby','submit','vote')
           AND mp.is_spectator = false
           AND mp.abandoned = false
           AND mp.honor_delta = 0`,
  );

  if ((rows as Array<unknown>).length === 0) return;

  // Lazy-load the helpers - top-level import would create a cycle since
  // honor/outcomes.ts imports schema.ts which imports back through here.
  const [{ isPresent }, { markPlayerAbandoned }] = await Promise.all([
    import('../presence/index.js'),
    import('../honor/outcomes.js'),
  ]);

  for (const row of rows as Array<{ match_id: string; user_id: string; mode: string }>) {
    const present = await isPresent(row.match_id, row.user_id);
    if (present) continue;
    await markPlayerAbandoned(row.match_id, row.user_id, row.mode).catch((err: Error) =>
      console.error('[grace] markPlayerAbandoned failed:', err.message),
    );
    console.log(`[grace] ${row.match_id}: ${row.user_id} marked abandoned`);
  }
}

// Vote-ring detection. Mutual upvote pairs (A votes for B, B votes for A,
// both with high weight, in nearby matches) get flagged into the reports
// queue for admin review. Rules-driven: minMutualVotePairs sets the
// threshold; maxIntervalMinutes scopes "nearby in time".
let lastRingScanAt = 0;

async function voteRingScan(): Promise<void> {
  const now = Date.now();
  // Run every 15 minutes - heavy query, low signal velocity.
  if (now - lastRingScanAt < 900_000) return;
  lastRingScanAt = now;

  const d = db();
  const { getCategory } = await import('../game-rules/loader.js');
  const votingRules = await getCategory('voting').catch(() => null);
  if (!votingRules || !votingRules.ringDetection.enabled) return;
  const minPairs = votingRules.ringDetection.minMutualVotePairs;
  const intervalMin = votingRules.ringDetection.maxIntervalMinutes;

  // Find pairs of users who voted on each other's submissions within
  // intervalMin minutes, with weight >= 4 (top 2 of 1-5 scale).
  // GROUP by ordered pair to dedupe (A,B) vs (B,A).
  const rows = await d.execute<{
    a: string;
    b: string;
    n_pairs: string;
  }>(
    sql`WITH mutual AS (
          SELECT
            LEAST(va.voter_id, vb.voter_id)    AS a,
            GREATEST(va.voter_id, vb.voter_id) AS b
            FROM votes va
            JOIN submissions sa ON sa.id = va.submission_id
            JOIN votes vb       ON vb.voter_id = sa.user_id
            JOIN submissions sb ON sb.id = vb.submission_id AND sb.user_id = va.voter_id
           WHERE va.weight >= 4
             AND vb.weight >= 4
             AND ABS(EXTRACT(EPOCH FROM (vb.created_at - va.created_at))) < ${intervalMin * 60}
             AND va.voter_id != vb.voter_id
        )
        SELECT a, b, COUNT(*)::text AS n_pairs
          FROM mutual
         GROUP BY a, b
         HAVING COUNT(*) >= ${minPairs}`,
  );

  const arr = rows as Array<{ a: string; b: string; n_pairs: string }>;
  for (const row of arr) {
    // Dedupe against existing open reports for this pair so we don't
    // spam the queue every 15 min until an admin acts.
    const existing = await d.execute<{ id: string }>(
      sql`SELECT id FROM reports
           WHERE status = 'open'
             AND reason = 'vote_ring'
             AND notes = ${`pair=${row.a},${row.b}`}
           LIMIT 1`,
    );
    if ((existing as Array<{ id: string }>).length > 0) continue;

    await d.execute(
      sql`INSERT INTO reports (subject_type, subject_id, reporter_id, reason, notes, status)
            VALUES ('profile', ${row.a}, NULL, 'vote_ring', ${`pair=${row.a},${row.b}`}, 'open')`,
    );
    console.log(
      `[vote-ring] flagged pair (${row.a}, ${row.b}) - ${row.n_pairs} mutual high-weight pairs`,
    );
  }

  // ── Triad signal: 3-cycle voting (A→B→C→A) where each leg has high
  // weight within the time window. Catches small rings the pair detector
  // misses.
  const triads = await d.execute<{
    a: string;
    b: string;
    c: string;
  }>(
    sql`WITH high AS (
          SELECT v.voter_id, s.user_id AS target_id, v.created_at
            FROM votes v JOIN submissions s ON s.id = v.submission_id
           WHERE v.weight >= 4 AND v.voter_id != s.user_id
        )
        SELECT DISTINCT ab.voter_id AS a, ab.target_id AS b, bc.target_id AS c
          FROM high ab
          JOIN high bc ON bc.voter_id = ab.target_id
          JOIN high ca ON ca.voter_id = bc.target_id AND ca.target_id = ab.voter_id
         WHERE ab.target_id != ab.voter_id
           AND bc.target_id != ab.voter_id
           AND bc.target_id != ab.target_id
           AND ab.voter_id < ab.target_id
           AND ab.voter_id < bc.target_id
         LIMIT 50`,
  );
  for (const row of triads as Array<{ a: string; b: string; c: string }>) {
    const note = `triad=${row.a},${row.b},${row.c}`;
    const exists = await d.execute<{ id: string }>(
      sql`SELECT id FROM reports
           WHERE status = 'open' AND reason = 'vote_ring' AND notes = ${note}
           LIMIT 1`,
    );
    if ((exists as Array<{ id: string }>).length > 0) continue;
    await d.execute(
      sql`INSERT INTO reports (subject_type, subject_id, reporter_id, reason, notes, status)
            VALUES ('profile', ${row.a}, NULL, 'vote_ring', ${note}, 'open')`,
    );
    console.log(`[vote-ring] flagged triad (${row.a}, ${row.b}, ${row.c})`);
  }

  // ── Signup-IP cluster signal: 3+ accounts that share a /24 signup
  // IP and have voted heavily for at least one shared subject. We look
  // up signup IP via the earliest session per user.
  const ipClusters = await d.execute<{
    cluster: string;
    user_ids: string[];
    n: string;
  }>(
    sql`WITH first_sess AS (
          SELECT s.user_id,
                 (SELECT s2.ip_address FROM sessions s2
                   WHERE s2.user_id = s.user_id
                   ORDER BY s2.created_at ASC LIMIT 1) AS ip
            FROM sessions s
           GROUP BY s.user_id
        ),
        cluster_24 AS (
          SELECT user_id,
                 -- best-effort /24 string for ipv4
                 regexp_replace(ip, '\\.\\d+$', '.0/24') AS cluster
            FROM first_sess
           WHERE ip ~ '^\\d+\\.\\d+\\.\\d+\\.\\d+$'
        ),
        with_votes AS (
          SELECT c.cluster, array_agg(DISTINCT c.user_id) AS user_ids,
                 COUNT(DISTINCT c.user_id) AS n
            FROM cluster_24 c
           WHERE EXISTS (
             SELECT 1 FROM votes v WHERE v.voter_id = c.user_id AND v.weight >= 4
           )
           GROUP BY c.cluster
        )
        SELECT cluster, user_ids, n::text FROM with_votes WHERE n >= 3 LIMIT 30`,
  );
  for (const row of ipClusters as Array<{ cluster: string; user_ids: string[]; n: string }>) {
    const note = `ip_cluster=${row.cluster}; users=${(row.user_ids ?? []).join(',')}`;
    const exists = await d.execute<{ id: string }>(
      sql`SELECT id FROM reports
           WHERE status = 'open' AND reason = 'vote_ring' AND notes = ${note}
           LIMIT 1`,
    );
    if ((exists as Array<{ id: string }>).length > 0) continue;
    const targetUserId = (row.user_ids ?? [])[0];
    if (!targetUserId) continue;
    await d.execute(
      sql`INSERT INTO reports (subject_type, subject_id, reporter_id, reason, notes, status)
            VALUES ('profile', ${targetUserId}, NULL, 'vote_ring', ${note}, 'open')`,
    );
    console.log(`[vote-ring] flagged IP cluster ${row.cluster} (${row.n} accounts)`);
  }
}

// Tournament scheduling. Two responsibilities, both fire from the same
// scan:
//   1. Registration locks: tournaments with status='open' whose
//      registration_closes_at has passed get flipped to 'starting' and
//      have their effective_size set to the next-power-of-two <= entries.
//      Round-1 matches are then created from the entrant list shuffled
//      seed order (winners advance via the round-up logic below).
//   2. Round advancement: in-progress tournaments check whether all
//      matches in the current round have status='results'. If so, take
//      the winners and pair them into the next round. When a round has
//      a single match and it ends, set the tournament status='finished'
//      and write winnerId.
let lastTournamentScheduleScanAt = 0;

async function tournamentScheduleScan(): Promise<void> {
  const now = Date.now();
  if (now - lastTournamentScheduleScanAt < 30_000) return; // every 30s
  lastTournamentScheduleScanAt = now;

  const d = db();

  // ── Lock registration on tournaments whose window has closed ─────────
  const opening = await d.execute<{ id: string }>(
    sql`SELECT id FROM tournaments
         WHERE status = 'open'
           AND registration_closes_at < now()
         LIMIT 10`,
  );
  for (const row of opening as Array<{ id: string }>) {
    await openRound1(row.id).catch((err: Error) =>
      console.error('[tournament-sched] openRound1 failed:', err.message),
    );
  }

  // ── Advance in-progress tournaments to next round (or finish) ──────
  const advancing = await d.execute<{ id: string }>(
    sql`SELECT t.id FROM tournaments t
         WHERE t.status IN ('starting', 'in_progress')
           AND NOT EXISTS (
             SELECT 1 FROM matches m
              WHERE m.tournament_id = t.id
                AND m.status NOT IN ('results', 'cancelled')
           )
           AND EXISTS (SELECT 1 FROM matches m2 WHERE m2.tournament_id = t.id)
         LIMIT 10`,
  );
  for (const row of advancing as Array<{ id: string }>) {
    await advanceRound(row.id).catch((err: Error) =>
      console.error('[tournament-sched] advanceRound failed:', err.message),
    );
  }
}

async function openRound1(tournamentId: string): Promise<void> {
  const d = db();
  const [t] = (await d.execute<{
    id: string;
    genre_id: string;
    max_entrants: number;
  }>(
    sql`SELECT id, genre_id, max_entrants FROM tournaments WHERE id = ${tournamentId} LIMIT 1`,
  )) as Array<{ id: string; genre_id: string; max_entrants: number }>;
  if (!t) return;

  const entrants = await d.execute<{ user_id: string }>(
    sql`SELECT user_id FROM tournament_entries WHERE tournament_id = ${tournamentId} ORDER BY registered_at ASC`,
  );
  const arr = entrants as Array<{ user_id: string }>;
  if (arr.length < 2) {
    await d.execute(sql`UPDATE tournaments SET status = 'cancelled' WHERE id = ${tournamentId}`);
    console.log(`[tournament-sched] ${tournamentId} cancelled - too few entrants`);
    return;
  }

  // Round to nearest power of 2 ≤ entrants.length, capped at max_entrants.
  const cap = Math.min(arr.length, t.max_entrants);
  let size = 1;
  while (size * 2 <= cap) size *= 2;

  // Shuffle for seeding.
  const seeded = arr.slice(0, size).sort(() => Math.random() - 0.5);

  // Generate `size/2` round-1 matches with primary_genre_id = tournament.genre_id.
  // submit_seconds left null so they default per-mode.
  for (let i = 0; i < seeded.length; i += 2) {
    const a = seeded[i];
    const b = seeded[i + 1];
    if (!a || !b) continue;
    const roomCode = generateRoomCode();
    const [m] = (await d.execute<{ id: string }>(
      sql`INSERT INTO matches
            (mode, status, room_code, team_size, team_count, primary_genre_id, sample_mode, tournament_id, tournament_round)
            VALUES ('tournament', 'lobby', ${roomCode}, 1, 2, ${t.genre_id}, 'generated', ${tournamentId}, 1)
            RETURNING id`,
    )) as Array<{ id: string }>;
    if (!m) continue;
    await d.execute(
      sql`INSERT INTO match_teams (match_id, seat, name) VALUES (${m.id}, 0, 'A'), (${m.id}, 1, 'B')`,
    );
    await d.execute(
      sql`INSERT INTO match_players (match_id, user_id, is_spectator, ready) VALUES
            (${m.id}, ${a.user_id}, false, false),
            (${m.id}, ${b.user_id}, false, false)`,
    );
    await d.execute(
      sql`INSERT INTO battle_phases (match_id, current_phase, transitions_at)
            VALUES (${m.id}, 'lobby'::match_phase, now() + interval '24 hours')`,
    );
  }

  await d.execute(
    sql`UPDATE tournaments SET status = 'in_progress', effective_size = ${size} WHERE id = ${tournamentId}`,
  );
  console.log(`[tournament-sched] ${tournamentId} opened round 1 with ${size / 2} matches`);
}

async function advanceRound(tournamentId: string): Promise<void> {
  const d = db();
  // Highest round so far for this tournament.
  const lastRoundRow = await d.execute<{ r: number; n: string }>(
    sql`SELECT MAX(tournament_round)::int AS r,
               COUNT(*)::text AS n
          FROM matches
         WHERE tournament_id = ${tournamentId}
           AND tournament_round IS NOT NULL`,
  );
  const lastRound = (lastRoundRow as Array<{ r: number; n: string }>)[0];
  if (!lastRound || lastRound.r === null) return;
  const currentRound = lastRound.r;

  // Find this round's winners.
  const winners = await d.execute<{ user_id: string }>(
    sql`SELECT s.user_id
          FROM submissions s
          JOIN matches m ON m.id = s.match_id
         WHERE m.tournament_id = ${tournamentId}
           AND m.tournament_round = ${currentRound}
           AND s.final_rank = 1
         ORDER BY m.created_at ASC`,
  );
  const winnerArr = winners as Array<{ user_id: string }>;

  if (winnerArr.length === 0) {
    // No clear winners (e.g. all rounds cancelled). Mark finished, no champ.
    await d.execute(sql`UPDATE tournaments SET status = 'finished' WHERE id = ${tournamentId}`);
    return;
  }

  if (winnerArr.length === 1) {
    // Champion!
    const winnerId = winnerArr[0]?.user_id;
    if (winnerId) {
      await d.execute(
        sql`UPDATE tournaments SET status = 'finished', winner_id = ${winnerId} WHERE id = ${tournamentId}`,
      );
      // Award the tournament_winner achievement.
      await d.execute(
        sql`INSERT INTO achievements (user_id, achievement_key) VALUES (${winnerId}, 'tournament_winner') ON CONFLICT DO NOTHING`,
      );
      console.log(`[tournament-sched] ${tournamentId} won by ${winnerId}`);
    }
    return;
  }

  // Pair winners into next-round matches.
  const nextRound = currentRound + 1;
  const [t] = (await d.execute<{ genre_id: string }>(
    sql`SELECT genre_id FROM tournaments WHERE id = ${tournamentId} LIMIT 1`,
  )) as Array<{ genre_id: string }>;
  if (!t) return;

  for (let i = 0; i < winnerArr.length; i += 2) {
    const a = winnerArr[i];
    const b = winnerArr[i + 1];
    if (!a || !b) continue;
    const roomCode = generateRoomCode();
    const [m] = (await d.execute<{ id: string }>(
      sql`INSERT INTO matches
            (mode, status, room_code, team_size, team_count, primary_genre_id, sample_mode, tournament_id, tournament_round)
            VALUES ('tournament', 'lobby', ${roomCode}, 1, 2, ${t.genre_id}, 'generated', ${tournamentId}, ${nextRound})
            RETURNING id`,
    )) as Array<{ id: string }>;
    if (!m) continue;
    await d.execute(
      sql`INSERT INTO match_teams (match_id, seat, name) VALUES (${m.id}, 0, 'A'), (${m.id}, 1, 'B')`,
    );
    await d.execute(
      sql`INSERT INTO match_players (match_id, user_id, is_spectator, ready) VALUES
            (${m.id}, ${a.user_id}, false, false),
            (${m.id}, ${b.user_id}, false, false)`,
    );
    await d.execute(
      sql`INSERT INTO battle_phases (match_id, current_phase, transitions_at)
            VALUES (${m.id}, 'lobby'::match_phase, now() + interval '24 hours')`,
    );
  }
  console.log(`[tournament-sched] ${tournamentId} advanced to round ${nextRound}`);
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Genre promotion scan. User-proposed genres start at status='proposed'
// with votingEndsAt = now + 7 days. When the window closes:
//   - genres with >= GENRE_VOTE_THRESHOLD unique votes flip to 'active'
//     (usable by everyone for match creation)
//   - genres below the threshold flip to 'archived' (hidden from public
//     lists; the row is preserved for audit / re-proposal).
// Threshold is 3 by default - matches the FAQ-documented promotion
// rule. Throttled to once per hour - this is a slow-moving signal.
const GENRE_VOTE_THRESHOLD = 3;
let lastGenrePromotionScanAt = 0;

async function genrePromotionScan(): Promise<void> {
  const now = Date.now();
  if (now - lastGenrePromotionScanAt < 3_600_000) return;
  lastGenrePromotionScanAt = now;

  const d = db();

  // Promote any proposed genre whose voting window has closed and has
  // at least the threshold of votes. Single SQL pass (idempotent via
  // status='proposed' guard).
  const promoted = await d.execute<{ id: string; slug: string; votes: string }>(
    sql`WITH eligible AS (
          SELECT g.id, g.slug,
                 (SELECT COUNT(*) FROM genre_votes gv WHERE gv.genre_id = g.id) AS votes
            FROM genres g
           WHERE g.status = 'proposed'
             AND g.voting_ends_at IS NOT NULL
             AND g.voting_ends_at < now()
        ),
        promoted AS (
          UPDATE genres SET status = 'active', voting_ends_at = NULL
           WHERE id IN (SELECT id FROM eligible WHERE votes >= ${GENRE_VOTE_THRESHOLD})
           RETURNING id, slug
        )
        SELECT p.id, p.slug, e.votes::text FROM promoted p JOIN eligible e ON e.id = p.id`,
  );
  for (const row of promoted as Array<{ id: string; slug: string; votes: string }>) {
    console.log(`[genre-promote] ${row.slug} promoted with ${row.votes} votes`);
  }

  // Archive any proposed genre whose window has closed and has fewer
  // votes than the threshold.
  const archived = await d.execute<{ id: string; slug: string; votes: string }>(
    sql`WITH eligible AS (
          SELECT g.id, g.slug,
                 (SELECT COUNT(*) FROM genre_votes gv WHERE gv.genre_id = g.id) AS votes
            FROM genres g
           WHERE g.status = 'proposed'
             AND g.voting_ends_at IS NOT NULL
             AND g.voting_ends_at < now()
        ),
        archived AS (
          UPDATE genres SET status = 'archived', voting_ends_at = NULL
           WHERE id IN (SELECT id FROM eligible WHERE votes < ${GENRE_VOTE_THRESHOLD})
           RETURNING id, slug
        )
        SELECT a.id, a.slug, e.votes::text FROM archived a JOIN eligible e ON e.id = a.id`,
  );
  for (const row of archived as Array<{ id: string; slug: string; votes: string }>) {
    console.log(`[genre-promote] ${row.slug} archived (only ${row.votes} votes)`);
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
      staleMatchSweep().catch((err: Error) => console.error('[sweep] error:', err.message));
      graceCheck().catch((err: Error) => console.error('[grace] error:', err.message));
      championScan().catch((err: Error) => console.error('[champion] error:', err.message));
      seasonSoftResetScan().catch((err: Error) =>
        console.error('[soft-reset] error:', err.message),
      );
      voteRingScan().catch((err: Error) => console.error('[vote-ring] error:', err.message));
      tournamentScheduleScan().catch((err: Error) =>
        console.error('[tournament-sched] error:', err.message),
      );
      genrePromotionScan().catch((err: Error) =>
        console.error('[genre-promote] error:', err.message),
      );
    }, 1000);
  });

  return () => {
    stopLeader();
    if (tickTimer) clearInterval(tickTimer);
  };
}
