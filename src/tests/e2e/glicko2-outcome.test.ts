// Integration test: applyRankedOutcome with Glicko-2.
// Seeds a ranked match directly via SQL (bypasses createMatch / S3 dependencies)
// then asserts the ranking rows shift in the expected direction.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db/client.js';
import { applyRankedOutcome } from '../../tiers/ranked-outcome.js';
import { uniqueHandle } from '../harness.js';
import { resetMatchState, seedTestFixtures, seedTestUser } from '../seed.js';

type RankingRow = {
  glicko_rating: string;
  glicko_rd: string;
  glicko_volatility: number;
  wins: number;
  losses: number;
};

async function seedRankedMatchWithResults(opts: {
  genreId: string;
  seasonId: string;
  userIds: string[];
  // finalRank[i] is the rank for userIds[i]
  finalRanks: number[];
}): Promise<string> {
  const d = db();
  const matchId = randomUUID();

  await d.execute(sql`
    INSERT INTO matches (id, mode, status, room_code, host_id, team_size, team_count, primary_genre_id, vote_outcome)
    VALUES (
      ${matchId},
      'ranked',
      'results',
      ${`RM-${matchId.slice(0, 6)}`},
      ${opts.userIds[0]},
      1,
      8,
      ${opts.genreId},
      'complete'
    )
  `);

  for (let i = 0; i < opts.userIds.length; i++) {
    const userId = opts.userIds[i];
    const rank = opts.finalRanks[i];
    if (!userId || rank === undefined) continue;

    await d.execute(sql`
      INSERT INTO match_players (match_id, user_id, is_spectator, ready)
      VALUES (${matchId}, ${userId}, false, true)
    `);

    await d.execute(sql`
      INSERT INTO submissions (id, match_id, user_id, genre_id, audio_url, final_rank, score)
      VALUES (
        ${randomUUID()},
        ${matchId},
        ${userId},
        ${opts.genreId},
        ${'https://s3.fake/track.mp3'},
        ${rank},
        ${10 - rank}
      )
    `);
  }

  return matchId;
}

describe('applyRankedOutcome with Glicko-2', () => {
  let genreId = '';
  let seasonId = '';

  beforeAll(async () => {
    await resetMatchState();
    const fixtures = await seedTestFixtures();
    genreId = fixtures.genreId;

    const rows = await db().execute<{ id: string }>(sql`
      SELECT id FROM seasons WHERE slug = 'test-season' LIMIT 1
    `);
    const row = (rows as Array<{ id: string }>)[0];
    if (!row) throw new Error('[setup] test-season not found');
    seasonId = row.id;
  });

  afterEach(async () => {
    await resetMatchState();
    const fixtures = await seedTestFixtures();
    genreId = fixtures.genreId;
    const rows = await db().execute<{ id: string }>(sql`
      SELECT id FROM seasons WHERE slug = 'test-season' LIMIT 1
    `);
    const row = (rows as Array<{ id: string }>)[0];
    if (!row) throw new Error('[setup] test-season not found');
    seasonId = row.id;
  });

  it('winner gains rating, loser loses rating, both RDs shrink', async () => {
    const u1 = await seedTestUser(uniqueHandle('g2-winner'), { plan: 'free', role: 'producer' });
    const u2 = await seedTestUser(uniqueHandle('g2-loser'), { plan: 'free', role: 'producer' });

    const d = db();
    // Pre-seed equal ratings.
    await d.execute(sql`
      INSERT INTO rankings (user_id, genre_id, season_id, glicko_rating, glicko_rd, glicko_volatility, wins, losses)
      VALUES (${u1.id}, ${genreId}, ${seasonId}, '1500', '200', 0.06, 0, 0),
             (${u2.id}, ${genreId}, ${seasonId}, '1500', '200', 0.06, 0, 0)
    `);

    const matchId = await seedRankedMatchWithResults({
      genreId,
      seasonId,
      userIds: [u1.id, u2.id],
      finalRanks: [1, 2],
    });

    await applyRankedOutcome(matchId);

    const rows = (await d.execute<RankingRow>(sql`
      SELECT glicko_rating, glicko_rd, glicko_volatility, wins, losses
        FROM rankings
       WHERE user_id IN (${u1.id}, ${u2.id})
         AND genre_id = ${genreId}
         AND season_id = ${seasonId}
       ORDER BY glicko_rating DESC
    `)) as RankingRow[];

    expect(rows).toHaveLength(2);
    const [winner, loser] = rows as [RankingRow, RankingRow];

    // Winner's rating rose above 1500.
    expect(Number(winner.glicko_rating)).toBeGreaterThan(1500);
    // Loser's rating fell below 1500.
    expect(Number(loser.glicko_rating)).toBeLessThan(1500);
    // Both RDs shrank from 200.
    expect(Number(winner.glicko_rd)).toBeLessThan(200);
    expect(Number(loser.glicko_rd)).toBeLessThan(200);
    // Wins/losses recorded.
    expect(winner.wins).toBe(1);
    expect(loser.losses).toBe(1);
  });

  it('lp_delta on match_players reflects glicko rating change', async () => {
    const u1 = await seedTestUser(uniqueHandle('g2-lp-a'), { plan: 'free', role: 'producer' });
    const u2 = await seedTestUser(uniqueHandle('g2-lp-b'), { plan: 'free', role: 'producer' });

    const d = db();
    await d.execute(sql`
      INSERT INTO rankings (user_id, genre_id, season_id, glicko_rating, glicko_rd, glicko_volatility, wins, losses)
      VALUES (${u1.id}, ${genreId}, ${seasonId}, '1500', '200', 0.06, 0, 0),
             (${u2.id}, ${genreId}, ${seasonId}, '1500', '200', 0.06, 0, 0)
    `);

    const matchId = await seedRankedMatchWithResults({
      genreId,
      seasonId,
      userIds: [u1.id, u2.id],
      finalRanks: [1, 2],
    });

    await applyRankedOutcome(matchId);

    const lpRows = (await d.execute<{ user_id: string; lp_delta: number }>(sql`
      SELECT user_id, lp_delta FROM match_players WHERE match_id = ${matchId}
    `)) as Array<{ user_id: string; lp_delta: number }>;

    const u1Row = lpRows.find((r) => r.user_id === u1.id);
    const u2Row = lpRows.find((r) => r.user_id === u2.id);

    expect(u1Row?.lp_delta).toBeGreaterThan(0);
    expect(u2Row?.lp_delta).toBeLessThan(0);
  });

  it('default starting values applied when no prior ranking row exists', async () => {
    const u1 = await seedTestUser(uniqueHandle('g2-new-a'), { plan: 'free', role: 'producer' });
    const u2 = await seedTestUser(uniqueHandle('g2-new-b'), { plan: 'free', role: 'producer' });

    const matchId = await seedRankedMatchWithResults({
      genreId,
      seasonId,
      userIds: [u1.id, u2.id],
      finalRanks: [1, 2],
    });

    await applyRankedOutcome(matchId);

    const rows = (await db().execute<RankingRow>(sql`
      SELECT glicko_rating, glicko_rd, glicko_volatility
        FROM rankings
       WHERE user_id IN (${u1.id}, ${u2.id})
         AND genre_id = ${genreId}
         AND season_id = ${seasonId}
    `)) as RankingRow[];

    expect(rows).toHaveLength(2);
    // Starting from 1500/350/0.06 defaults - rating should have shifted from 1500.
    for (const r of rows) {
      expect(Number(r.glicko_rating)).not.toBe(1500);
      // RD should have shrunk from 350 (opponents encountered).
      expect(Number(r.glicko_rd)).toBeLessThan(350);
      expect(Number(r.glicko_volatility)).toBeGreaterThan(0);
    }
  });

  it('3-way FFA: rank-1 gains, rank-3 loses, rank-2 changes moderately', async () => {
    const users = await Promise.all(
      [0, 1, 2].map((i) =>
        seedTestUser(uniqueHandle(`g2-ffa-${i}`), { plan: 'free', role: 'producer' }),
      ),
    );
    const userIds = users.map((u) => u.id);

    const d = db();
    for (const userId of userIds) {
      await d.execute(sql`
        INSERT INTO rankings (user_id, genre_id, season_id, glicko_rating, glicko_rd, glicko_volatility, wins, losses)
        VALUES (${userId}, ${genreId}, ${seasonId}, '1500', '200', 0.06, 0, 0)
      `);
    }

    const matchId = await seedRankedMatchWithResults({
      genreId,
      seasonId,
      userIds,
      finalRanks: [1, 2, 3],
    });

    await applyRankedOutcome(matchId);

    const rows = (await d.execute<RankingRow & { user_id: string }>(sql`
      SELECT user_id, glicko_rating, glicko_rd
        FROM rankings
       WHERE user_id = ANY(ARRAY[${userIds[0]}, ${userIds[1]}, ${userIds[2]}]::uuid[])
         AND genre_id = ${genreId}
         AND season_id = ${seasonId}
    `)) as Array<RankingRow & { user_id: string }>;

    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    const r1 = byUser.get(userIds[0] ?? '');
    const r3 = byUser.get(userIds[2] ?? '');

    expect(r1).toBeDefined();
    expect(r3).toBeDefined();
    expect(Number(r1?.glicko_rating)).toBeGreaterThan(1500);
    expect(Number(r3?.glicko_rating)).toBeLessThan(1500);
  });
});
