// E2E test for showcase-only (bracket_enabled=false) tournaments.
//
// Validates the full lifecycle:
//   open -> showcase -> finished (no bracket)
//
// Asserts:
//   - winner_id is set to the rank-1 showcase user
//   - status becomes 'finished'
//   - no matches rows for the tournament (no bracket was created)
//   - tournament_winner achievement is awarded to the rank-1 user

import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/client.js';
import { finalizeShowcase, finalizeShowcaseOnlyTournament } from '../../realtime/tick.js';
import { buildTestApp, postJson, uniqueHandle } from '../harness.js';
import { TEST_GENRE_SLUG, resetMatchState, seedTestFixtures, seedTestUser } from '../seed.js';

async function genreId(): Promise<string> {
  const rows = (await db().execute<{ id: string }>(
    sql`SELECT id FROM genres WHERE slug = ${TEST_GENRE_SLUG} LIMIT 1`,
  )) as Array<{ id: string }>;
  if (!rows[0]) throw new Error('test genre not seeded');
  return rows[0].id;
}

async function insertShowcaseOnlyTournament(): Promise<string> {
  const gid = await genreId();
  const id = (
    (await db().execute<{ id: string }>(
      sql`INSERT INTO tournaments
            (name, genre_id, starts_at, registration_closes_at, max_entrants,
             auto_created, bracket_enabled, showcase_seconds, status)
          VALUES
            ('Test showcase-only', ${gid},
             now() + interval '8 days', now() + interval '1 hour',
             32, true, false, 604800, 'open')
          RETURNING id`,
    )) as Array<{ id: string }>
  )[0]?.id;
  if (!id) throw new Error('failed to insert tournament');
  return id;
}

async function openShowcasePhase(tournamentId: string): Promise<void> {
  await db().execute(
    sql`UPDATE tournaments
           SET status = 'showcase',
               showcase_starts_at = now(),
               showcase_ends_at = now() + interval '7 days'
         WHERE id = ${tournamentId}`,
  );
}

async function insertShowcaseSubmission(tournamentId: string, userId: string): Promise<string> {
  const id = (
    (await db().execute<{ id: string }>(
      sql`INSERT INTO tournament_showcase_submissions
            (tournament_id, user_id, audio_url, title, duration_sec)
          VALUES
            (${tournamentId}, ${userId}, 'https://cdn.example.com/test.mp3',
             'Test track', 120)
          ON CONFLICT (tournament_id, user_id) DO NOTHING
          RETURNING id`,
    )) as Array<{ id: string }>
  )[0]?.id;
  // If conflict (already exists), fetch the existing id.
  if (!id) {
    const existing = (
      (await db().execute<{ id: string }>(
        sql`SELECT id FROM tournament_showcase_submissions
             WHERE tournament_id = ${tournamentId} AND user_id = ${userId} LIMIT 1`,
      )) as Array<{ id: string }>
    )[0]?.id;
    if (!existing) throw new Error('failed to insert showcase submission');
    return existing;
  }
  return id;
}

async function insertShowcaseVote(
  submissionId: string,
  voterId: string,
  weight: number,
): Promise<void> {
  await db().execute(
    sql`INSERT INTO tournament_showcase_votes (submission_id, voter_id, weight)
          VALUES (${submissionId}, ${voterId}, ${String(weight)})
        ON CONFLICT DO NOTHING`,
  );
}

describe('tournament showcase-only lifecycle', () => {
  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
    await db().execute(sql`DELETE FROM tournament_entries`);
    await db().execute(sql`DELETE FROM tournaments WHERE auto_created = true`);
  });

  it('finishes with winner_id = rank-1 showcase user, no matches created', async () => {
    const tournamentId = await insertShowcaseOnlyTournament();

    // Register 3 producers.
    const producers = await Promise.all(
      ['so-p1', 'so-p2', 'so-p3'].map((tag) =>
        seedTestUser(uniqueHandle(`so-${tag}`), { plan: 'free', role: 'producer' }),
      ),
    );
    for (const p of producers) {
      const app = buildTestApp({ asUser: p });
      const res = await postJson(app, `/tournaments/${tournamentId}/register`, {});
      expect(res.status).toBe(201);
    }

    await openShowcasePhase(tournamentId);

    // Give producers different vote totals. p2 (producers[1]) gets the highest total.
    // We use a separate voter (any producer can vote on others' tracks).
    if (!producers[0] || !producers[1] || !producers[2]) throw new Error('producers missing');
    const sub0 = await insertShowcaseSubmission(tournamentId, producers[0].id);
    const sub1 = await insertShowcaseSubmission(tournamentId, producers[1].id);
    const sub2 = await insertShowcaseSubmission(tournamentId, producers[2].id);

    // Vote totals: sub1 gets 7, sub0 gets 3, sub2 gets 1.
    // Use cross-votes (producers vote on each other).
    await insertShowcaseVote(sub0, producers[1].id, 3); // p2 -> p1 track: 3 pts
    await insertShowcaseVote(sub0, producers[2].id, 0); // p3 -> p1 track: 0 pts (total = 3)
    await insertShowcaseVote(sub1, producers[0].id, 4); // p1 -> p2 track: 4 pts
    await insertShowcaseVote(sub1, producers[2].id, 3); // p3 -> p2 track: 3 pts (total = 7)
    await insertShowcaseVote(sub2, producers[0].id, 1); // p1 -> p3 track: 1 pt  (total = 1)

    // Finalize showcase (computes SUM(weight) per sub then ranks; writes final_rank).
    await finalizeShowcase(tournamentId);

    // Verify final_rank was written.
    const ranked = (await db().execute<{ user_id: string; final_rank: number }>(
      sql`SELECT user_id, final_rank FROM tournament_showcase_submissions
           WHERE tournament_id = ${tournamentId}
           ORDER BY final_rank ASC`,
    )) as Array<{ user_id: string; final_rank: number }>;
    expect(ranked[0]?.user_id).toBe(producers[1].id); // score 7 = rank 1
    expect(ranked[0]?.final_rank).toBe(1);

    // Crown the winner.
    await finalizeShowcaseOnlyTournament(tournamentId);

    // Tournament must be finished with the right winner.
    const [tRow] = (await db().execute<{ status: string; winner_id: string | null }>(
      sql`SELECT status, winner_id FROM tournaments WHERE id = ${tournamentId}`,
    )) as Array<{ status: string; winner_id: string | null }>;
    expect(tRow?.status).toBe('finished');
    expect(tRow?.winner_id).toBe(producers[1].id);

    // No bracket matches should exist.
    const matchCount = Number(
      (
        (await db().execute<{ n: string }>(
          sql`SELECT COUNT(*)::text AS n FROM matches WHERE tournament_id = ${tournamentId}`,
        )) as Array<{ n: string }>
      )[0]?.n ?? '0',
    );
    expect(matchCount).toBe(0);

    // tournament_winner achievement awarded to rank-1 user.
    const [ach] = (await db().execute<{ achievement_key: string }>(
      sql`SELECT achievement_key FROM achievements
            WHERE user_id = ${producers[1].id}
              AND achievement_key = 'tournament_winner'
            LIMIT 1`,
    )) as Array<{ achievement_key: string }>;
    expect(ach?.achievement_key).toBe('tournament_winner');
  });

  it('finishes with no winner_id when there are no showcase submissions', async () => {
    const tournamentId = await insertShowcaseOnlyTournament();

    // Register 2 producers but neither uploads a showcase track.
    const producers = await Promise.all(
      ['so-empty1', 'so-empty2'].map((tag) =>
        seedTestUser(uniqueHandle(`so-${tag}`), { plan: 'free', role: 'producer' }),
      ),
    );
    for (const p of producers) {
      const app = buildTestApp({ asUser: p });
      await postJson(app, `/tournaments/${tournamentId}/register`, {});
    }

    await openShowcasePhase(tournamentId);
    await finalizeShowcase(tournamentId);
    await finalizeShowcaseOnlyTournament(tournamentId);

    const [tRow] = (await db().execute<{ status: string; winner_id: string | null }>(
      sql`SELECT status, winner_id FROM tournaments WHERE id = ${tournamentId}`,
    )) as Array<{ status: string; winner_id: string | null }>;
    expect(tRow?.status).toBe('finished');
    expect(tRow?.winner_id).toBeNull();

    // Still no bracket matches.
    const matchCount = Number(
      (
        (await db().execute<{ n: string }>(
          sql`SELECT COUNT(*)::text AS n FROM matches WHERE tournament_id = ${tournamentId}`,
        )) as Array<{ n: string }>
      )[0]?.n ?? '0',
    );
    expect(matchCount).toBe(0);
  });

  it('tournament detail API returns bracketEnabled=false and showcaseLeaderboard', async () => {
    const tournamentId = await insertShowcaseOnlyTournament();

    const p = await seedTestUser(uniqueHandle('so-api'), { plan: 'free', role: 'producer' });
    const app = buildTestApp({ asUser: p });

    // Register and simulate a finished showcase.
    await postJson(app, `/tournaments/${tournamentId}/register`, {});
    await openShowcasePhase(tournamentId);
    await insertShowcaseSubmission(tournamentId, p.id);
    // finalizeShowcase will rank the single submission as rank=1 (no votes needed).
    await finalizeShowcase(tournamentId);
    await finalizeShowcaseOnlyTournament(tournamentId);

    const res = await app.request(`/tournaments/${tournamentId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bracketEnabled: boolean;
      status: string;
      showcaseLeaderboard: Array<{ handle: string; finalRank: number }>;
    };
    expect(body.bracketEnabled).toBe(false);
    expect(body.status).toBe('finished');
    expect(body.showcaseLeaderboard).toHaveLength(1);
    expect(body.showcaseLeaderboard[0]?.handle).toBe(p.handle);
    expect(body.showcaseLeaderboard[0]?.finalRank).toBe(1);
  });
});
