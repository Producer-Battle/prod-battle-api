// Minimal seed + safe reset used by every e2e test file.
//
// seedTestFixtures() upserts: 1 system genre ("phonk"), 1 pool sample pack
// for that genre, 1 active flip source. These are all the ambient rows the
// route handlers need to create any match mode.
//
// resetMatchState() truncates only match-scoped tables. It refuses to run
// unless DATABASE_URL names a database that contains "test" in its name -
// the guard exists because the rest of the app shares the same Postgres
// instance locally and we never want this helper to run against dev data.

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { flipSources, gameRules, genres, samplePacks, seasons, users } from '../db/schema.js';
import { env } from '../env.js';
import { _resetCacheForTest } from '../game-rules/loader.js';
import type { AuthUser } from '../middleware/session.js';

export const TEST_GENRE_SLUG = 'phonk';

export type TestFixtures = {
  genreId: string;
  packId: string;
  flipSourceId: string;
};

function unwrap<T>(rows: T[], what: string): T {
  const r = rows[0];
  if (!r) throw new Error(`[seed] insert did not return a row for ${what}`);
  return r;
}

// Idempotently re-seed game_rules + the active season after a TRUNCATE.
// Both tables have FKs to users (game_rules.updated_by, no FK on seasons)
// so TRUNCATE CASCADE on users wipes game_rules. Tests need both to exist
// for any code that reads honor/tier/voting rules or the active-season id.
async function seedRulesAndSeasons(): Promise<void> {
  const d = db();

  // Active season covering "now". Single all-encompassing range so any
  // test running at any wall-clock time finds an active row.
  await d
    .insert(seasons)
    .values({
      slug: 'test-season',
      startsAt: new Date('2020-01-01T00:00:00Z'),
      endsAt: new Date('2099-01-01T00:00:00Z'),
    })
    .onConflictDoNothing();

  // Defaults mirror migration 0017. Kept minimal here - tests only
  // need the values they actually exercise; the migration is the
  // source of truth for production payloads.
  const ruleSeed: Array<{ category: string; payload: object }> = [
    {
      category: 'honor',
      payload: {
        start: 100,
        max: 100,
        regenPerCleanDay: 1,
        regenBurstPerCleanQpMatches: { matches: 10, amount: 5 },
        firstOffenceWindowDays: 30,
        firstOffenceMultiplier: 0.5,
        penalties: {
          quickplay_lobby: -1,
          quickplay_mid: -2,
          quickplay_empty: -3,
          ranked_lobby: -2,
          ranked_mid: -5,
          ranked_empty: -3,
          private_lobby: -1,
          private_mid: -2,
          private_empty: -2,
          flip_lobby: -1,
          flip_mid: -2,
          flip_empty: -3,
          daily_lobby: -1,
          daily_mid: -2,
          daily_empty: -3,
          tournament_lobby: -3,
          tournament_mid: -10,
          tournament_empty: -5,
          dmca_first: -5,
          dmca_second: -15,
          dmca_third: -25,
          vote_ring_confirmed: -50,
        },
        gates: { tournament: 70, ranked: 50, privateHosting: 30, readOnlyBelow: 10 },
        perks: {
          trustedAt: 90,
          voteWeightBoostAt: 90,
          voteWeightBoostMultiplier: 1.5,
          extraQuickplaySlotAt: 95,
          extraQuickplaySlotAfterDays: 30,
        },
      },
    },
    {
      category: 'tiers',
      payload: {
        calibrationMatches: 10,
        softResetPercent: 0.6,
        softResetFloorOffset: -1,
        lpClampBase: 30,
        lpClampPerLp: 200,
        boundaries: [
          { name: 'bronze', min: 0, max: 100 },
          { name: 'silver', min: 100, max: 250 },
          { name: 'gold', min: 250, max: 500 },
          { name: 'platinum', min: 500, max: 1000 },
          { name: 'diamond', min: 1000, max: 2000 },
          { name: 'master', min: 2000, max: 3500 },
          { name: 'grandmaster', min: 3500, max: null },
        ],
        subdivisions: 3,
        promoSeriesEnabled: false,
      },
    },
    {
      category: 'voting',
      payload: {
        // Test seed sets the gate to 0 - existing e2e tests build fresh
        // users per scenario and would never clear a 3-match warmup.
        // Production migration 0017 keeps it at 3.
        minMatchesBeforeVotesCount: 0,
        selfVoteAllowed: false,
        downvotesEnabled: false,
        honorWeightCurve: [
          { honorMin: 0, weight: 0 },
          { honorMin: 30, weight: 1.0 },
          { honorMin: 90, weight: 1.5 },
          { honorMin: 100, weight: 1.5 },
        ],
        premiumVoteWeightBonus: 0.25,
        velocityCapPerSubmissionPerHour: 30,
        ringDetection: { enabled: true, minMutualVotePairs: 5, maxIntervalMinutes: 5 },
      },
    },
    {
      category: 'revenue',
      payload: {
        creatorPoolPercentOfPremium: 5,
        minPayoutThresholdCents: 500,
        rolloverIfBelow: true,
        payoutCadenceDays: 30,
      },
    },
    {
      category: 'achievements',
      payload: {
        enabled: { tier_grandmaster: true, daily_champion: true, match_streak_7: true },
      },
    },
    {
      category: 'reconnect',
      payload: {
        graceSeconds: 120,
        lobbyAutoReadyTimeoutSeconds: 60,
        heartbeatIntervalSeconds: 15,
      },
    },
  ];
  for (const r of ruleSeed) {
    await d.insert(gameRules).values(r).onConflictDoNothing();
  }

  // Bust the loader cache so the next read reflects what we just wrote.
  _resetCacheForTest();
}

export async function seedTestFixtures(): Promise<TestFixtures> {
  await seedRulesAndSeasons();
  const d = db();

  const [existingGenre] = await d
    .select()
    .from(genres)
    .where(eq(genres.slug, TEST_GENRE_SLUG))
    .limit(1);
  let genreId = existingGenre?.id;
  if (!genreId) {
    const row = unwrap(
      await d
        .insert(genres)
        .values({
          slug: TEST_GENRE_SLUG,
          name: 'Phonk',
          kind: 'system',
          status: 'active',
          stemTypes: ['kick', 'snare', 'hihat', '808'],
        })
        .returning(),
      'genres',
    );
    genreId = row.id;
  }

  const [existingPack] = await d
    .select()
    .from(samplePacks)
    .where(eq(samplePacks.genreId, genreId))
    .limit(1);
  let packId = existingPack?.id;
  if (!packId) {
    const row = unwrap(
      await d
        .insert(samplePacks)
        .values({
          genreId,
          kind: 'pool',
          name: 'test-pool-a',
          samples: [
            {
              stemType: 'kick',
              name: 'kick-01',
              url: 'http://localhost:9000/pb-test/stems/kick-01.wav',
            },
            {
              stemType: 'snare',
              name: 'snare-01',
              url: 'http://localhost:9000/pb-test/stems/snare-01.wav',
            },
            {
              stemType: 'hihat',
              name: 'hihat-01',
              url: 'http://localhost:9000/pb-test/stems/hihat-01.wav',
            },
            {
              stemType: '808',
              name: '808-01',
              url: 'http://localhost:9000/pb-test/stems/808-01.wav',
            },
          ],
        })
        .returning(),
      'sample_packs',
    );
    packId = row.id;
  }

  const [existingFlip] = await d
    .select()
    .from(flipSources)
    .where(eq(flipSources.genreId, genreId))
    .limit(1);
  let flipSourceId = existingFlip?.id;
  if (!flipSourceId) {
    const row = unwrap(
      await d
        .insert(flipSources)
        .values({
          label: 'test-flip-loop',
          genreId,
          url: 'https://example.com/flip.wav',
          source: 'upload',
          durationSec: 8,
          active: true,
        })
        .returning(),
      'flip_sources',
    );
    flipSourceId = row.id;
  }

  return { genreId, packId, flipSourceId };
}

/**
 * Insert a user row with the given handle, plan, and role. Returns the shape
 * expected by buildTestApp({ asUser: ... }). Email defaults to
 * `${handle}@test.local`.
 */
export async function seedTestUser(
  handle: string,
  opts: { plan: AuthUser['plan']; role: AuthUser['role'] },
): Promise<{
  id: string;
  handle: string;
  email: string;
  role: AuthUser['role'];
  plan: AuthUser['plan'];
}> {
  const d = db();
  const email = `${handle}@test.local`;
  const [row] = await d
    .insert(users)
    .values({
      handle,
      email,
      role: opts.role,
      plan: opts.plan,
      emailVerified: true,
    })
    .onConflictDoNothing()
    .returning();

  if (!row) {
    // Row already exists (handle/email collision); look it up.
    const [existing] = await d.select().from(users).where(eq(users.handle, handle)).limit(1);
    if (!existing)
      throw new Error(`[seed] seedTestUser: could not insert or find user "${handle}"`);
    return {
      id: existing.id,
      handle: existing.handle,
      email: existing.email,
      role: opts.role,
      plan: opts.plan,
    };
  }

  return { id: row.id, handle: row.handle, email: row.email, role: opts.role, plan: opts.plan };
}

function assertTestDatabase(): void {
  const url = env.DATABASE_URL ?? '';
  // Accept anything with "test" in the path OR an explicit PB_TEST_DB=1
  // escape hatch for exotic setups. Default-deny - we never truncate
  // against a DB that doesn't look like a test DB.
  if (process.env.PB_TEST_DB === '1') return;
  const tail = url.split('/').pop() ?? '';
  if (!tail.toLowerCase().includes('test')) {
    throw new Error(
      `[tests] Refusing to truncate: DATABASE_URL database name must contain "test" (got "${tail}"). Set PB_TEST_DB=1 to override.`,
    );
  }
}

/**
 * Truncate match-scoped tables and the user table. Leaves genres, sample
 * packs, and flip sources intact so seedTestFixtures() is only called
 * once per suite rather than once per file.
 */
export async function resetMatchState(): Promise<void> {
  assertTestDatabase();
  const d = db();
  // Silence the TRUNCATE CASCADE "cascades to table X" NOTICEs so the test
  // output stays readable. The cascade also wipes genres / sample_packs /
  // flip_sources (they reference users.createdBy via FK, which TRUNCATE
  // cascades through regardless of the FK's ON DELETE action); the
  // beforeEach hook in each test file re-seeds those fixtures.
  await d.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL client_min_messages = WARNING`);
    await tx.execute(
      sql`TRUNCATE TABLE
            votes,
            submission_likes,
            submission_tags,
            submissions,
            battle_phases,
            match_players,
            match_teams,
            matches,
            sessions,
            accounts,
            verifications,
            users
          RESTART IDENTITY CASCADE`,
    );
  });
}
