// Match-start sample-pack generator.
//
// When a match is created with sample_mode='generated', this module picks
// ONE pool pack at random for the match's genre and links the match to it.
// Every producer in the match gets the exact same kit (same kick, snare,
// etc. - that's the whole point of the "shared samples" format).
//
// We do NOT create a new sample_packs row per match anymore. Pool packs
// have pre-built ZIPs (uploaded at seed time), so there's nothing to compute
// per match - just reference the pool pack.

import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { genres, matchPlayers, matches, samplePacks } from '../db/schema.js';

export type SamplePack = typeof samplePacks.$inferSelect;

// Cap on how far back the random picker reaches. Once the pool grows past a
// few hundred packs it becomes unlikely that any single user has heard the
// most recent uploads, so we keep the picker fresh by limiting to the most
// recently-added N. Tweak if the catalogue feels stale.
export const RECENT_POOL_LIMIT = 5;

export interface GenerateOptions {
  /** Seeded random function for deterministic tests. Defaults to Math.random. */
  random?: () => number;
  /** When set, prefer pool packs this user hasn't played yet. */
  userId?: string | null;
}

/**
 * Pick a random pool pack for the given genre. Returns the pool pack row.
 *
 * Picks from the {@link RECENT_POOL_LIMIT} most-recently-added pool packs.
 * When `userId` is provided, prefers packs that user has never played; falls
 * back to the full recent window if they've heard everything in it.
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
  const userId = options.userId ?? null;
  const d = db();

  const [genre] = await d.select().from(genres).where(eq(genres.slug, genreSlug)).limit(1);
  if (!genre) {
    throw new Error(`Genre not found for slug: ${genreSlug}`);
  }

  const pools = await d
    .select()
    .from(samplePacks)
    .where(and(eq(samplePacks.genreId, genre.id), eq(samplePacks.kind, 'pool')))
    .orderBy(desc(samplePacks.createdAt))
    .limit(RECENT_POOL_LIMIT);

  if (pools.length === 0) {
    throw new Error(
      `No pool packs for "${genreSlug}". Run scripts/seed-stems-synth.ts to populate the pool.`,
    );
  }

  // Filter out packs this user has already heard. If they've heard them all,
  // fall through to the full recent window so the match can still start.
  let candidates = pools;
  if (userId) {
    const ids = pools.map((p) => p.id);
    const seen = await d
      .selectDistinct({ samplePackId: matches.samplePackId })
      .from(matchPlayers)
      .innerJoin(matches, eq(matchPlayers.matchId, matches.id))
      .where(
        and(
          eq(matchPlayers.userId, userId),
          isNotNull(matches.samplePackId),
          inArray(matches.samplePackId, ids),
        ),
      );
    const seenIds = new Set(seen.map((r) => r.samplePackId));
    const fresh = pools.filter((p) => !seenIds.has(p.id));
    if (fresh.length > 0) candidates = fresh;
  }

  const picked = candidates[Math.floor(random() * candidates.length)];
  if (!picked) throw new Error('pool pack selection failed');
  return picked;
}
