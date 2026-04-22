// Helpers to query pool packs from the sample_packs table for a given genre.
//
// Pool packs (kind='pool') are curated per genre and seeded via scripts/seed-stems.ts.
// They are the source from which per-match generated packs are assembled.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type SamplePackItem, samplePacks } from '../db/schema.js';

export type SamplePack = typeof samplePacks.$inferSelect;

/**
 * Return all pool packs for the given genre UUID.
 */
export async function listPoolPacks(genreId: string): Promise<SamplePack[]> {
  const d = db();
  return d
    .select()
    .from(samplePacks)
    .where(eq(samplePacks.genreId, genreId))
    .then((rows) => rows.filter((r) => r.kind === 'pool'));
}

/**
 * Flatten all pool packs for a genre into a map of stemType → candidate items.
 *
 * Example output:
 *   {
 *     kick:  [{ stemType: 'kick', name: 'phonk-kick-01', url: '...' }, ...],
 *     snare: [...],
 *     ...
 *   }
 */
export async function getPoolStems(genreId: string): Promise<Record<string, SamplePackItem[]>> {
  const packs = await listPoolPacks(genreId);
  const result: Record<string, SamplePackItem[]> = {};

  for (const pack of packs) {
    for (const item of pack.samples) {
      if (!result[item.stemType]) {
        result[item.stemType] = [];
      }
      result[item.stemType]?.push(item);
    }
  }

  return result;
}
