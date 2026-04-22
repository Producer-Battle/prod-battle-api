// Match-start sample-pack generator.
//
// When a match is created with sample_mode='generated', this module picks
// ONE pool pack at random for the match's genre and links the match to it.
// Every producer in the match gets the exact same kit (same kick, snare,
// etc. — that's the whole point of the "shared samples" format).
//
// We do NOT create a new sample_packs row per match anymore. Pool packs
// have pre-built ZIPs (uploaded at seed time), so there's nothing to compute
// per match — just reference the pool pack.

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { genres, samplePacks } from '../db/schema.js';

export type SamplePack = typeof samplePacks.$inferSelect;

export interface GenerateOptions {
  /** Seeded random function for deterministic tests. Defaults to Math.random. */
  random?: () => number;
}

/**
 * Pick a random pool pack for the given genre. Returns the pool pack row.
 *
 * Throws if:
 *   - The genre slug doesn't match a known genre row.
 *   - There are no pool packs seeded for this genre.
 */
export async function generateMatchPack(
  _matchId: string,
  genreSlug: string,
  options: GenerateOptions = {},
): Promise<SamplePack> {
  const random = options.random ?? Math.random;
  const d = db();

  const [genre] = await d.select().from(genres).where(eq(genres.slug, genreSlug)).limit(1);
  if (!genre) {
    throw new Error(`Genre not found for slug: ${genreSlug}`);
  }

  const pools = await d
    .select()
    .from(samplePacks)
    .where(and(eq(samplePacks.genreId, genre.id), eq(samplePacks.kind, 'pool')));

  if (pools.length === 0) {
    throw new Error(
      `No pool packs for "${genreSlug}". Run scripts/seed-stems-synth.ts to populate the pool.`,
    );
  }

  const picked = pools[Math.floor(random() * pools.length)];
  if (!picked) throw new Error('pool pack selection failed');
  return picked;
}
