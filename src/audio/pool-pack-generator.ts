// Shared helper for generating pool sample packs from Freesound.
//
// Extracted from scripts/fetch-freesound-stems.ts so both the CLI script
// and the admin API route (POST /admin/genres/:id/generate-pool-pack and
// POST /admin/sample-packs/:id/regenerate) share the same path without
// duplication. Synchronous, rate-limited by a 150ms inter-request delay
// to stay well under Freesound's 60 req/min cap.

import { type SamplePackItem, genres, samplePacks } from '../db/schema.js';
import { oggToWav } from './convert.js';
import { downloadPreview, searchStems } from './freesound.js';
import { publicUrl, putObject } from './s3.js';

// Freesound query per stem type. Unknown types fall back to "{stemType} oneshot".
export const QUERY_BY_STEM: Record<string, string> = {
  kick: 'kick drum oneshot',
  snare: 'snare drum oneshot',
  hihat: 'hi hat closed oneshot',
  openhat: 'open hi hat',
  clap: 'clap oneshot',
  '808': '808 bass sub',
  perc: 'percussion oneshot',
  fx: 'sfx sweep riser',
  cowbell: 'cowbell',
  vocal: 'vocal chop',
  bass: 'bass oneshot',
  lead: 'synth lead',
  pad: 'synth pad',
  screech: 'hardstyle screech',
  zap: 'zap synth',
  reverse: 'reverse cymbal',
};

// Short one-shots vs longer melodic stems: affects maxDurationSec filter.
const SHORT_STEMS = new Set([
  'kick',
  'snare',
  'hihat',
  'openhat',
  'clap',
  '808',
  'perc',
  'cowbell',
]);

/**
 * Fetch a single stem from Freesound, convert ogg -> wav, upload to S3.
 * Returns a SamplePackItem on success, null on any failure.
 */
export async function fetchAndStoreStem(
  genreSlug: string,
  stemType: string,
): Promise<SamplePackItem | null> {
  const query = QUERY_BY_STEM[stemType] ?? `${stemType} oneshot`;
  const isShort = SHORT_STEMS.has(stemType);
  try {
    const results = await searchStems({
      query,
      count: 1,
      maxDurationSec: isShort ? 2 : 6,
      minDurationSec: 0.1,
      page: 1 + Math.floor(Math.random() * 3),
    });
    const sample = results[0];
    if (!sample) {
      console.warn(`[pool-pack] no freesound hit for ${genreSlug}/${stemType}`);
      return null;
    }

    const ogg = await downloadPreview(sample);
    const wav = await oggToWav(ogg);
    const key = `stems/${genreSlug}/${stemType}-${sample.id}.wav`;
    await putObject(key, Buffer.from(wav), 'audio/wav');
    return {
      stemType,
      name: `fs-${sample.id}-${sample.name}`.replace(/[^a-zA-Z0-9-._]/g, '_').slice(0, 60),
      url: publicUrl(key),
    };
  } catch (err) {
    console.warn(`[pool-pack] ${genreSlug}/${stemType} failed:`, (err as Error).message);
    return null;
  }
}

/** Sleep helper to respect Freesound rate limits. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Generate a full pool pack for a genre by fetching one stem per stemType
 * from Freesound. Returns the list of SamplePackItems that were successfully
 * fetched (may be empty if every stem failed).
 */
export async function generatePackItems(
  genreSlug: string,
  stemTypes: readonly string[],
): Promise<SamplePackItem[]> {
  const items: SamplePackItem[] = [];
  for (const stemType of stemTypes) {
    const item = await fetchAndStoreStem(genreSlug, stemType);
    if (item) items.push(item);
    // 150ms inter-request delay keeps us comfortably under 60 req/min.
    await sleep(150);
  }
  return items;
}

// Re-export schema types so callers can import from one place.
export type { SamplePackItem };
export { genres, samplePacks };
