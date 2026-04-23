// Populate the sample-pack pool from Freesound.org.
//
// For each system genre, pull ~N stems per stemType, convert .ogg → .wav
// with ffmpeg, upload to Object Storage at stems/{genre}/{stemType}/{id}.wav,
// and insert a `sample_packs` row with kind='pool'.
//
// This runs once to seed, or on a schedule to refresh the pool. In prod it
// lives as a Scaleway Serverless Job defined in prod-battle-infra/modules/jobs.
//
// Prereq: FREESOUND_API_KEY set, Postgres reachable, Object Storage reachable,
// ffmpeg installed locally (for the dev run; prod uses the job's container).
//
// Queries per stemType - kept simple; tune over time:
//   kick    → "kick oneshot"
//   snare   → "snare oneshot"
//   hihat   → "hihat closed"
//   808     → "808 bass sub"
//   clap    → "clap oneshot"
//   openhat → "open hihat"
//   perc    → "percussion oneshot"
//   fx      → "sfx oneshot sweep"
//   etc.

import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { type SamplePackItem, genres, samplePacks } from '../src/db/schema.js';
import { GENRE_STEMS } from '../src/matchmaking/defaults.js';
import { oggToWav } from '../src/audio/convert.js';
import { downloadPreview, searchStems } from '../src/audio/freesound.js';
import { publicUrl, putObject } from '../src/audio/s3.js';

const QUERY_BY_STEM: Record<string, string> = {
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

const STEMS_PER_TYPE = 4; // 4 choices per stem type per pool pack
const POOL_PACKS_PER_GENRE = 3;

async function fetchAndStoreStem(
  genreSlug: string,
  stemType: string,
  idx: number,
): Promise<SamplePackItem | null> {
  const query = QUERY_BY_STEM[stemType] ?? `${stemType} oneshot`;
  const isShort = ['kick', 'snare', 'hihat', 'openhat', 'clap', '808', 'perc', 'cowbell'].includes(
    stemType,
  );
  const results = await searchStems({
    query,
    count: 1,
    maxDurationSec: isShort ? 2 : 6,
    minDurationSec: 0.1,
    page: 1 + Math.floor(Math.random() * 3),
  });
  const sample = results[0];
  if (!sample) {
    console.warn(`[stems] no freesound hit for ${genreSlug}/${stemType}`);
    return null;
  }

  try {
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
    console.warn(`[stems] ${genreSlug}/${stemType} #${idx} failed:`, (err as Error).message);
    return null;
  }
}

async function main() {
  const d = db();
  const genreRows = await d.select().from(genres).where(eq(genres.kind, 'system'));

  for (const g of genreRows) {
    const stems = GENRE_STEMS[g.slug];
    if (!stems) {
      console.log(`[stems] skipping ${g.slug} - no stem set defined`);
      continue;
    }

    // Drop existing pool packs for this genre so we start clean.
    await d
      .delete(samplePacks)
      .where(and(eq(samplePacks.genreId, g.id), eq(samplePacks.kind, 'pool')));

    for (let packIdx = 0; packIdx < POOL_PACKS_PER_GENRE; packIdx++) {
      const packLabel = String.fromCharCode(65 + packIdx); // A, B, C…
      console.log(`[stems] ${g.slug} pool-${packLabel}…`);
      const items: SamplePackItem[] = [];
      for (const stemType of stems) {
        for (let i = 0; i < STEMS_PER_TYPE; i++) {
          const stem = await fetchAndStoreStem(g.slug, stemType, i);
          if (stem) items.push(stem);
          // Respect Freesound's rate limit - sleep 150ms between requests.
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      if (items.length === 0) continue;
      await d.insert(samplePacks).values({
        genreId: g.id,
        kind: 'pool',
        name: `${g.slug}-pool-${packLabel}`,
        samples: items,
      });
      console.log(`[stems]   inserted ${g.slug}-pool-${packLabel} (${items.length} stems)`);
    }
  }

  console.log('[stems] done.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
