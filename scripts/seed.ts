// Default seed - the minimum the app needs to work from a fresh DB.
//
// Today that's just the system genre catalogue. No demo users, no demo
// matches, no placeholder sample packs. Real content is created by real
// users (sign-up, /genres/propose, /packs/new), so starting clean avoids
// fake rows polluting the leaderboard / feed / admin overview.
//
// Opt into the old demo content (4 fake producers, two finished matches,
// two practice submissions with SoundHelix audio, pool packs with
// localhost:9002 URLs) with `--with-demo`:
//
//   pnpm tsx scripts/seed.ts --with-demo
//
// Idempotent - running any variant twice is safe.

import { eq, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import {
  genres,
  matchPlayers,
  matchTeams,
  matches,
  producerProfiles,
  samplePacks,
  submissions,
  users,
} from '../src/db/schema.js';
import { MVP_SYSTEM_GENRES } from '../src/genres/registry.js';
import { GENRE_STEMS } from '../src/matchmaking/defaults.js';

const DEMO_MINIO_BASE = 'http://localhost:9002/audio/stems';
const DEMO_STEMS_PER_TYPE = 4;
const DEMO_PACKS_PER_GENRE = 3;

async function seedGenres(d: ReturnType<typeof db>): Promise<void> {
  console.log('[seed] system genres…');
  for (const g of MVP_SYSTEM_GENRES) {
    // Upsert: the registry is authoritative for system genres. Update name /
    // formatConfig / stemTypes on every run so prod catches up when the
    // registry changes. User-proposed genres (kind='user') have their own
    // slugs and are never touched by this seeder.
    await d
      .insert(genres)
      .values({
        slug: g.slug,
        name: g.name,
        kind: 'system',
        formatConfig: g.formatConfig,
        status: 'active',
        stemTypes: GENRE_STEMS[g.slug] as string[] | undefined,
      })
      .onConflictDoUpdate({
        target: genres.slug,
        set: {
          name: g.name,
          formatConfig: g.formatConfig,
          stemTypes: GENRE_STEMS[g.slug] as string[] | undefined,
        },
      });
  }
}

async function seedDemoStems(d: ReturnType<typeof db>): Promise<void> {
  const genreRows = await d.select().from(genres);
  const genreBySlug = Object.fromEntries(genreRows.map((r) => [r.slug, r]));

  for (const [genreSlug, stemTypes] of Object.entries(GENRE_STEMS)) {
    const genre = genreBySlug[genreSlug];
    if (!genre) continue;

    const existingPacks = await d
      .select({ id: samplePacks.id, kind: samplePacks.kind })
      .from(samplePacks)
      .where(eq(samplePacks.genreId, genre.id));

    if (existingPacks.some((r) => r.kind === 'pool')) {
      console.log(`[seed] pool stems for "${genreSlug}" already exist - skipping`);
      continue;
    }

    console.log(`[seed] seeding pool stems for "${genreSlug}"…`);
    for (let packIdx = 0; packIdx < DEMO_PACKS_PER_GENRE; packIdx++) {
      const packLabel = String.fromCharCode(65 + packIdx);
      const baseIndex = packIdx * DEMO_STEMS_PER_TYPE + 1;
      const samples = stemTypes.flatMap((stemType) =>
        Array.from({ length: DEMO_STEMS_PER_TYPE }, (_, i) => {
          const n = String(baseIndex + i).padStart(2, '0');
          return {
            stemType,
            name: `${genreSlug}-${stemType}-${n}`,
            url: `${DEMO_MINIO_BASE}/${genreSlug}/${stemType}-${n}.wav`,
          };
        }),
      );
      await d.insert(samplePacks).values({
        genreId: genre.id,
        kind: 'pool',
        name: `${genreSlug}-pool-${packLabel}`,
        samples,
      });
    }
  }
}

async function seedDemoContent(d: ReturnType<typeof db>): Promise<void> {
  const genreRows = await d.select().from(genres);
  const genreBySlug = Object.fromEntries(genreRows.map((r) => [r.slug, r]));

  console.log('[seed:demo] demo producers…');
  const demoUsers = [
    { handle: 'polystalgia', email: 'polystalgia@demo.local' },
    { handle: 'knxwnoise', email: 'knxwnoise@demo.local' },
    { handle: 'mayflower', email: 'mayflower@demo.local' },
    { handle: 'dj_kickrush', email: 'dj_kickrush@demo.local' },
  ];
  for (const u of demoUsers) {
    await d.insert(users).values(u).onConflictDoNothing({ target: users.handle });
  }
  const userRows = await d.select().from(users);
  const userByHandle = Object.fromEntries(userRows.map((u) => [u.handle, u]));

  for (const u of userRows) {
    await d
      .insert(producerProfiles)
      .values({
        userId: u.id,
        bio: `${u.handle} - demo producer`,
        openToAr: true,
      })
      .onConflictDoNothing({ target: producerProfiles.userId });
  }

  console.log('[seed:demo] demo match + submissions…');
  const phonk = genreBySlug.phonk;
  if (!phonk) {
    console.log('[seed:demo] phonk genre missing; skipping demo match');
    return;
  }
  const existing = await d
    .select()
    .from(matches)
    .where(sql`${matches.roomCode} = 'DEMO01'`);
  if (existing.length > 0) {
    console.log('[seed:demo] demo match already exists - skipping');
    return;
  }

  const poly = userByHandle.polystalgia;
  const knx = userByHandle.knxwnoise;
  if (!poly || !knx) throw new Error('demo users missing after seed');

  const [match] = await d
    .insert(matches)
    .values({
      mode: 'quickplay',
      status: 'results',
      roomCode: 'DEMO01',
      hostId: poly.id,
      teamSize: 1,
      teamCount: 2,
      primaryGenreId: phonk.id,
      submitSeconds: 300,
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
      endedAt: new Date(Date.now() - 30 * 60 * 1000),
    })
    .returning();
  if (!match) throw new Error('insert match returned no row');

  const [teamA, teamB] = await d
    .insert(matchTeams)
    .values([
      { matchId: match.id, seat: 0, name: 'A', finalRank: 1 },
      { matchId: match.id, seat: 1, name: 'B', finalRank: 2 },
    ])
    .returning();
  if (!teamA || !teamB) throw new Error('insert teams returned no rows');

  await d.insert(matchPlayers).values([
    { matchId: match.id, userId: poly.id, teamId: teamA.id, finalRank: 1 },
    { matchId: match.id, userId: knx.id, teamId: teamB.id, finalRank: 2 },
  ]);

  await d.insert(submissions).values([
    {
      matchId: match.id,
      userId: poly.id,
      genreId: phonk.id,
      audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
      durationSec: 371,
      title: 'drift drums',
      description: 'quick phonk loop, heavy 808s',
      finalRank: 1,
      score: '0.62',
      plays: 142,
      likes: 28,
      isPublic: true,
    },
    {
      matchId: match.id,
      userId: knx.id,
      genreId: phonk.id,
      audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
      durationSec: 426,
      title: 'night ride',
      description: 'slower phonk, cowbell-forward',
      finalRank: 2,
      score: '0.38',
      plays: 98,
      likes: 19,
      isPublic: true,
    },
  ]);

  console.log('[seed:demo] pool sample packs…');
  await seedDemoStems(d);
}

async function main() {
  const d = db();
  const withDemo = process.argv.includes('--with-demo');

  await seedGenres(d);

  if (withDemo) {
    await seedDemoContent(d);
  } else {
    console.log(
      '[seed] genre catalogue only. Pass --with-demo to also insert fake users / matches.',
    );
  }

  console.log('[seed] done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
