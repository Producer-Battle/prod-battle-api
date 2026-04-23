// Seed pool sample packs for each MVP genre.
//
// For each genre in GENRE_STEMS, inserts 3 pool packs containing multiple
// stems per stem type (4 candidates per stem type per pack). This gives the
// match-start generator at least 4 options per stem slot to pick from.
//
// Audio URLs use the local MinIO endpoint with deterministic placeholder keys.
// TODO: once the ffmpeg/upload path is live, replace these placeholder URLs
//   with real uploaded stems by running the upload pipeline and updating the
//   rows (or reseeding). The placeholder keys follow the pattern:
//     http://localhost:9002/audio/stems/{genreSlug}/{stemType}-{N:02d}.wav
//
// Idempotent: if any pool packs already exist for a genre, that genre is
// skipped entirely so re-running is safe.

import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { genres, samplePacks } from '../src/db/schema.js';
import { MVP_SYSTEM_GENRES } from '../src/genres/registry.js';
import { GENRE_STEMS } from '../src/matchmaking/defaults.js';

const MINIO_BASE = 'http://localhost:9002/audio/stems';

/** How many candidate stems to seed per stem-type per pool pack. */
const STEMS_PER_TYPE = 4;

/** How many pool packs to seed per genre. */
const PACKS_PER_GENRE = 3;

async function main() {
  const d = db();

  console.log('[seed-stems] loading genres from DB…');
  const genreRows = await d.select().from(genres);
  const genreBySlug = Object.fromEntries(genreRows.map((r) => [r.slug, r]));

  // Warn if any MVP genre isn't in the DB yet (seed.ts should have run first).
  for (const g of MVP_SYSTEM_GENRES) {
    if (!genreBySlug[g.slug]) {
      console.warn(`[seed-stems] genre "${g.slug}" not found in DB - run scripts/seed.ts first`);
    }
  }

  for (const [genreSlug, stemTypes] of Object.entries(GENRE_STEMS)) {
    const genre = genreBySlug[genreSlug];
    if (!genre) {
      console.warn(`[seed-stems] skipping "${genreSlug}" - not in DB`);
      continue;
    }

    // Idempotency: skip if any pool packs already exist for this genre.
    const existingPacks = await d
      .select({ id: samplePacks.id, kind: samplePacks.kind })
      .from(samplePacks)
      .where(eq(samplePacks.genreId, genre.id));

    const poolCount = existingPacks.filter((r) => r.kind === 'pool').length;

    if (poolCount > 0) {
      console.log(`[seed-stems] "${genreSlug}" already has ${poolCount} pool pack(s) - skipping`);
      continue;
    }

    console.log(`[seed-stems] seeding ${PACKS_PER_GENRE} pool packs for "${genreSlug}"…`);

    for (let packIdx = 0; packIdx < PACKS_PER_GENRE; packIdx++) {
      const packLabel = String.fromCharCode(65 + packIdx); // 'A', 'B', 'C'
      const packName = `${genreSlug}-pool-${packLabel}`;

      // Each pack gets a distinct set of stem indices so the generator has
      // genuine variety to pick from across packs. Pack A → indices 01-04,
      // pack B → 05-08, pack C → 09-12.
      const baseIndex = packIdx * STEMS_PER_TYPE + 1;
      const samples = stemTypes.flatMap((stemType) =>
        Array.from({ length: STEMS_PER_TYPE }, (_, i) => {
          const n = String(baseIndex + i).padStart(2, '0');
          return {
            stemType,
            name: `${genreSlug}-${stemType}-${n}`,
            url: `${MINIO_BASE}/${genreSlug}/${stemType}-${n}.wav`,
          };
        }),
      );

      await d.insert(samplePacks).values({
        genreId: genre.id,
        kind: 'pool',
        name: packName,
        samples,
      });

      console.log(`[seed-stems]   inserted "${packName}" (${samples.length} stems)`);
    }
  }

  console.log('[seed-stems] done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed-stems] failed:', err);
  process.exit(1);
});
