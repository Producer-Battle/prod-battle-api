// Curate the pool sample packs so the in-match kit looks like a real pack:
// one well-named sample per stem type (instead of the demo seeder's 4 generic
// "<genre>-kick-05..08" slots). Keeps URLs pointed at MinIO so the stems still
// play + the pack ZIP still builds. Idempotent.
//
//   pnpm tsx scripts/seed-marketing-kits.ts

import { eq, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { samplePacks } from '../src/db/schema.js';

const MINIO = (n: number) =>
  `http://localhost:9002/prod-battle-local-audio/stems/beat${((n - 1) % 8) + 1}.wav`;

// One realistic name per stem type (what a producer-facing kit would label them).
const NAME: Record<string, string> = {
  kick: 'Punchy Kick',
  snare: 'Layered Snare',
  hihat: 'Closed Hat',
  openhat: 'Open Hat',
  clap: 'Tight Clap',
  perc: 'Shaker Perc',
  '808': 'Gliding 808',
  bass: 'Reese Bass',
  sub: 'Sub Bass',
  lead: 'Saw Lead',
  pad: 'Warm Pad',
  fx: 'Riser FX',
  vocal: 'Vocal Chop',
  zap: 'Laser Zap',
  screech: 'Screech',
  reverse: 'Reverse Crash',
  cowbell: 'Cowbell',
};
const nameFor = (t: string) => NAME[t] ?? t.charAt(0).toUpperCase() + t.slice(1);

async function main() {
  const d = db();
  const packs = await d.select().from(samplePacks).where(sql`kind = 'pool'`);
  let pi = 0;
  for (const p of packs) {
    // Preserve the pack's stem types (in order), one curated sample each.
    const types: string[] = [];
    for (const s of (p.samples as Array<{ stemType: string }>) ?? []) {
      if (!types.includes(s.stemType)) types.push(s.stemType);
    }
    const samples = types.map((t, idx) => ({
      stemType: t,
      name: nameFor(t),
      url: MINIO(idx + 1 + pi),
    }));
    await d.update(samplePacks).set({ samples }).where(eq(samplePacks.id, p.id));
    pi++;
  }
  console.log(`[kits] curated ${packs.length} pool packs -> one named sample per stem type`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[kits] failed:', e);
  process.exit(1);
});
