// Synthesizes one stem per stemType per pool pack with ffmpeg, uploads
// them to Scaleway Object Storage at the canonical layout, and builds a
// per-pack ZIP.
//
//   {genre}/samples/pack{N}/{stemType}.wav
//   {genre}/samplepack{N}.zip
//
// Each genre gets POOL_PACKS_PER_GENRE packs, each containing one WAV per
// stem type defined in GENRE_STEMS. Matches pick a pool pack at random;
// every producer in a room gets the exact same kit (stems + zip URL).
//
// Runs against whatever S3_* env vars you source — MinIO is gone; staging
// uses the Scaleway bucket created by prod-battle-infra's storage module.

import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import archiver from 'archiver';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { type SamplePackItem, genres, samplePacks } from '../src/db/schema.js';
import { GENRE_STEMS } from '../src/matchmaking/defaults.js';
import { publicUrl, putObject } from '../src/audio/s3.js';

const POOL_PACKS_PER_GENRE = 3;

type SynthArgs = (variant: number) => string;

/**
 * Per-stem-type ffmpeg lavfi source → filter chain. Deterministic on the
 * variant index so packs A/B/C give three distinct sounds for each stem.
 */
const STEM_SYNTH: Record<string, SynthArgs> = {
  kick: (v) => {
    const freq = 50 + v * 6;
    return `sine=frequency=${freq}:duration=0.45,volume=2,afade=t=out:st=0.02:d=0.42`;
  },
  snare: (v) => {
    const hp = 180 + v * 40;
    return `anoisesrc=duration=0.22:color=white:seed=${v + 11},highpass=f=${hp},afade=t=out:st=0.04:d=0.17`;
  },
  hihat: (v) => {
    const hp = 7000 + v * 700;
    return `anoisesrc=duration=0.09:color=white:seed=${v + 3},highpass=f=${hp},afade=t=out:st=0.015:d=0.07`;
  },
  openhat: (v) => {
    const hp = 5500 + v * 500;
    return `anoisesrc=duration=0.35:color=white:seed=${v + 7},highpass=f=${hp},afade=t=out:st=0.1:d=0.25`;
  },
  clap: (v) => {
    const seed = v + 19;
    return `anoisesrc=duration=0.28:color=white:seed=${seed},highpass=f=1200,afade=t=out:st=0.1:d=0.18`;
  },
  '808': (v) => {
    const freq = 36 + v * 4;
    return `sine=frequency=${freq}:duration=1.1,volume=2.2,afade=t=out:st=0.05:d=1.05`;
  },
  perc: (v) => {
    const freq = 200 + v * 140;
    return `sine=frequency=${freq}:duration=0.18,volume=1.3,afade=t=out:st=0.01:d=0.17`;
  },
  fx: (v) => {
    const start = 300 + v * 200;
    return `sine=frequency=${start}:duration=1.2,volume=1.5,afade=t=in:st=0:d=0.1,afade=t=out:st=0.6:d=0.6`;
  },
  cowbell: (v) => {
    const freq = 540 + v * 40;
    return `sine=frequency=${freq}:duration=0.35,volume=1.5,afade=t=out:st=0.05:d=0.3`;
  },
  vocal: (v) => {
    const freq = 220 + v * 30;
    return `sine=frequency=${freq}:duration=0.7,volume=1.2,afade=t=in:st=0:d=0.1,afade=t=out:st=0.5:d=0.2`;
  },
  bass: (v) => {
    const freq = 80 + v * 10;
    return `sine=frequency=${freq}:duration=0.9,volume=1.8,afade=t=out:st=0.1:d=0.8`;
  },
  lead: (v) => {
    const freq = 440 + v * 80;
    return `sine=frequency=${freq}:duration=0.8,volume=1.2,afade=t=out:st=0.2:d=0.6`;
  },
  pad: (v) => {
    const freq = 220 + v * 20;
    return `sine=frequency=${freq}:duration=2.0,volume=0.8,afade=t=in:st=0:d=0.3,afade=t=out:st=1.4:d=0.6`;
  },
  screech: (v) => {
    const start = 1800 + v * 400;
    return `sine=frequency=${start}:duration=0.6,volume=1.4,afade=t=in:st=0:d=0.05,afade=t=out:st=0.3:d=0.3`;
  },
  zap: (v) => {
    const freq = 2400 + v * 300;
    return `sine=frequency=${freq}:duration=0.15,volume=1.3,afade=t=out:st=0.02:d=0.13`;
  },
  reverse: (v) => {
    const freq = 600 + v * 60;
    return `sine=frequency=${freq}:duration=0.8,volume=1,afade=t=in:st=0:d=0.7,areverse`;
  },
};

async function renderWav(filterChain: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        filterChain,
        '-ar',
        '44100',
        '-ac',
        '1',
        '-t',
        '2.5',
        '-f',
        'wav',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

/** Bundle a set of {filename → bytes} into a ZIP buffer. */
async function buildZip(files: Array<{ filename: string; body: Buffer }>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const collector = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk as Buffer);
      cb();
    },
  });
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(collector);
  for (const f of files) archive.append(f.body, { name: f.filename });

  await new Promise<void>((resolve, reject) => {
    collector.on('finish', () => resolve());
    archive.on('error', reject);
    archive.finalize().catch(reject);
  });
  return Buffer.concat(chunks);
}

async function main() {
  const d = db();
  const genreRows = await d.select().from(genres).where(eq(genres.kind, 'system'));

  let totalFiles = 0;
  let totalZips = 0;

  for (const g of genreRows) {
    const stems = GENRE_STEMS[g.slug];
    if (!stems) {
      console.log(`[synth] skipping ${g.slug} — no stem set`);
      continue;
    }

    // Fresh start for this genre's pool.
    await d
      .delete(samplePacks)
      .where(and(eq(samplePacks.genreId, g.id), eq(samplePacks.kind, 'pool')));

    for (let packIdx = 0; packIdx < POOL_PACKS_PER_GENRE; packIdx++) {
      const packNum = packIdx + 1;
      const packDir = `${g.slug}/samples/pack${packNum}`;
      const items: SamplePackItem[] = [];
      const zipEntries: Array<{ filename: string; body: Buffer }> = [];

      for (const stemType of stems) {
        const synth = STEM_SYNTH[stemType];
        if (!synth) {
          console.warn(`[synth] no recipe for ${stemType}`);
          continue;
        }
        try {
          const wav = await renderWav(synth(packIdx));
          const filename = `${stemType}.wav`;
          const key = `${packDir}/${filename}`;
          await putObject(key, wav, 'audio/wav');
          items.push({ stemType, name: stemType, url: publicUrl(key) });
          zipEntries.push({ filename, body: wav });
          totalFiles++;
        } catch (err) {
          console.warn(`[synth] ${g.slug}/pack${packNum}/${stemType}: ${(err as Error).message}`);
        }
      }

      if (items.length === 0) continue;

      // Bundle + upload the per-pack ZIP.
      const zipBuf = await buildZip(zipEntries);
      const zipKey = `${g.slug}/samplepack${packNum}.zip`;
      await putObject(zipKey, zipBuf, 'application/zip');
      const zipUrl = publicUrl(zipKey);
      totalZips++;

      await d.insert(samplePacks).values({
        genreId: g.id,
        kind: 'pool',
        name: `${g.slug}-pack${packNum}`,
        samples: items,
        zipUrl,
      });
      console.log(`[synth] ${g.slug}/pack${packNum}: ${items.length} stems + 1 zip`);
    }
  }

  console.log(`[synth] done. ${totalFiles} WAVs + ${totalZips} ZIPs uploaded.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
