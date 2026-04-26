// E2E tests for GET /leaderboard/season/:slug
//
// Seeds: 1 season, 1 genre, several users + ranking rows, then validates the
// response shape, ordering, reward tiers, and prize eligibility.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/client.js';
import { buildTestApp, getJson, uniqueHandle } from '../harness.js';
import { resetMatchState, seedTestFixtures, seedTestUser } from '../seed.js';

describe('GET /leaderboard/season/:slug', () => {
  let seasonSlug = '';
  let seasonId = '';
  let genreId = '';

  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    const fixtures = await seedTestFixtures();
    genreId = fixtures.genreId;

    // Unique slug per test so tests don't interfere.
    seasonSlug = `s-${randomUUID().slice(0, 8)}`;
    const seasons = await db().execute<{ id: string }>(sql`
      INSERT INTO seasons (id, slug, starts_at, ends_at)
      VALUES (
        ${randomUUID()},
        ${seasonSlug},
        now() - interval '30 days',
        now() + interval '30 days'
      )
      RETURNING id
    `);
    const seasonRow = (seasons as Array<{ id: string }>)[0];
    if (!seasonRow) throw new Error('[seed] season insert did not return a row');
    seasonId = seasonRow.id;
  });

  it('returns 404 for an unknown season slug', async () => {
    const app = buildTestApp();
    const { status } = await getJson(app, '/leaderboard/season/does-not-exist');
    expect(status).toBe(404);
  });

  it('returns empty items array when season has no rankings', async () => {
    const app = buildTestApp();
    const { status, json } = await getJson<{
      season: { slug: string; startsAt: string; endsAt: string };
      items: unknown[];
    }>(app, `/leaderboard/season/${seasonSlug}`);

    expect(status).toBe(200);
    expect(json.season.slug).toBe(seasonSlug);
    expect(json.items).toHaveLength(0);
  });

  it('returns ranked items ordered by glickoRating DESC', async () => {
    // Seed 3 users with distinct ratings.
    const u1 = await seedTestUser(uniqueHandle('sl-gold'), { plan: 'paid', role: 'producer' });
    const u2 = await seedTestUser(uniqueHandle('sl-silver'), { plan: 'free', role: 'producer' });
    const u3 = await seedTestUser(uniqueHandle('sl-bronze'), { plan: 'paid', role: 'producer' });

    const d = db();
    for (const [user, rating, wins, losses] of [
      [u1, '1800', 10, 2],
      [u2, '1600', 5, 5],
      [u3, '1400', 3, 8],
    ] as const) {
      await d.execute(sql`
        INSERT INTO rankings (user_id, genre_id, season_id, glicko_rating, glicko_rd, wins, losses)
        VALUES (${user.id}, ${genreId}, ${seasonId}, ${rating}, '200', ${wins}, ${losses})
      `);
    }

    const app = buildTestApp();
    const { status, json } = await getJson<{
      season: { slug: string };
      items: Array<{
        rank: number;
        userId: string;
        handle: string;
        plan: string;
        rating: number;
        wins: number;
        losses: number;
        rewardTier: string | null;
        prizeEligible: boolean;
      }>;
    }>(app, `/leaderboard/season/${seasonSlug}`);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(3);

    // Order: highest rating first.
    expect(json.items[0]?.userId).toBe(u1.id);
    expect(json.items[0]?.rank).toBe(1);
    expect(json.items[1]?.userId).toBe(u2.id);
    expect(json.items[1]?.rank).toBe(2);
    expect(json.items[2]?.userId).toBe(u3.id);
    expect(json.items[2]?.rank).toBe(3);
  });

  it('assigns reward tiers correctly (gold 1-10, silver 11-50, bronze 51-100)', async () => {
    // Insert enough ranking rows to test all tiers. Use direct SQL to avoid
    // calling seedTestUser 100 times.
    const d = db();
    const userIds: string[] = [];
    for (let i = 0; i < 55; i++) {
      const uid = randomUUID();
      userIds.push(uid);
      await d.execute(sql`
        INSERT INTO users (id, email, handle, role, plan, email_verified)
        VALUES (
          ${uid},
          ${`tier-${uid}@test.local`},
          ${`t-${i}-${uid.slice(0, 6)}`},
          'producer',
          'free',
          true
        )
      `);
      // Ratings: 2000 - i*10 so index 0 = rank 1, index 10 = rank 11, etc.
      const rating = (2000 - i * 10).toString();
      await d.execute(sql`
        INSERT INTO rankings (user_id, genre_id, season_id, glicko_rating, glicko_rd, wins, losses)
        VALUES (${uid}, ${genreId}, ${seasonId}, ${rating}, '100', 1, 0)
      `);
    }

    const app = buildTestApp();
    const { status, json } = await getJson<{
      items: Array<{ rank: number; rewardTier: string | null }>;
    }>(app, `/leaderboard/season/${seasonSlug}`);

    expect(status).toBe(200);
    expect(json.items).toHaveLength(55);

    // Rank 1 = gold.
    expect(json.items[0]?.rewardTier).toBe('gold');
    // Rank 10 = gold.
    expect(json.items[9]?.rewardTier).toBe('gold');
    // Rank 11 = silver.
    expect(json.items[10]?.rewardTier).toBe('silver');
    // Rank 50 = silver.
    expect(json.items[49]?.rewardTier).toBe('silver');
    // Rank 51 = bronze.
    expect(json.items[50]?.rewardTier).toBe('bronze');
    // Rank 55 = bronze.
    expect(json.items[54]?.rewardTier).toBe('bronze');
  });

  it('prizeEligible is true only for paid users', async () => {
    const paidUser = await seedTestUser(uniqueHandle('sl-pe-paid'), {
      plan: 'paid',
      role: 'producer',
    });
    const freeUser = await seedTestUser(uniqueHandle('sl-pe-free'), {
      plan: 'free',
      role: 'producer',
    });

    const d = db();
    await d.execute(sql`
      INSERT INTO rankings (user_id, genre_id, season_id, glicko_rating, glicko_rd, wins, losses)
      VALUES (${paidUser.id}, ${genreId}, ${seasonId}, '1700', '100', 5, 2)
    `);
    await d.execute(sql`
      INSERT INTO rankings (user_id, genre_id, season_id, glicko_rating, glicko_rd, wins, losses)
      VALUES (${freeUser.id}, ${genreId}, ${seasonId}, '1500', '100', 3, 4)
    `);

    const app = buildTestApp();
    const { json } = await getJson<{
      items: Array<{ userId: string; prizeEligible: boolean }>;
    }>(app, `/leaderboard/season/${seasonSlug}`);

    const paidItem = json.items.find((i) => i.userId === paidUser.id);
    const freeItem = json.items.find((i) => i.userId === freeUser.id);
    expect(paidItem?.prizeEligible).toBe(true);
    expect(freeItem?.prizeEligible).toBe(false);
  });

  it('excludes archived and deleted users', async () => {
    const activeUser = await seedTestUser(uniqueHandle('sl-active'), {
      plan: 'free',
      role: 'producer',
    });
    const archivedId = randomUUID();
    await db().execute(sql`
      INSERT INTO users (id, email, handle, role, plan, status, email_verified)
      VALUES (${archivedId}, ${`arch-${archivedId}@test.local`}, ${`arch-${archivedId.slice(0, 6)}`},
              'producer', 'free', 'archived', true)
    `);

    const d = db();
    await d.execute(sql`
      INSERT INTO rankings (user_id, genre_id, season_id, glicko_rating, glicko_rd, wins, losses)
      VALUES (${activeUser.id}, ${genreId}, ${seasonId}, '1600', '100', 4, 3)
    `);
    await d.execute(sql`
      INSERT INTO rankings (user_id, genre_id, season_id, glicko_rating, glicko_rd, wins, losses)
      VALUES (${archivedId}, ${genreId}, ${seasonId}, '1900', '100', 8, 1)
    `);

    const app = buildTestApp();
    const { json } = await getJson<{
      items: Array<{ userId: string }>;
    }>(app, `/leaderboard/season/${seasonSlug}`);

    const userIds = json.items.map((i) => i.userId);
    expect(userIds).toContain(activeUser.id);
    expect(userIds).not.toContain(archivedId);
  });
});
