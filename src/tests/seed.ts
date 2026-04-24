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
import { flipSources, genres, samplePacks } from '../db/schema.js';
import { env } from '../env.js';

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

export async function seedTestFixtures(): Promise<TestFixtures> {
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
            { stemType: 'kick', name: 'kick-01', url: 'https://example.com/kick.wav' },
            { stemType: 'snare', name: 'snare-01', url: 'https://example.com/snare.wav' },
            { stemType: 'hihat', name: 'hihat-01', url: 'https://example.com/hihat.wav' },
            { stemType: '808', name: '808-01', url: 'https://example.com/808.wav' },
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
