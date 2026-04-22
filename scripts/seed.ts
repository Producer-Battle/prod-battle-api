// Seeds the local dev DB with system genres, demo producers, a finished
// match + submissions so the /feed + /genres endpoints have content to return,
// and pool sample packs for all MVP genres (via seed-stems logic).
// Idempotent — running twice is safe (ON CONFLICT DO NOTHING on slugs).

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

const MINIO_BASE = 'http://localhost:9002/audio/stems';
const STEMS_PER_TYPE = 4;
const PACKS_PER_GENRE = 3;

async function seedStems(d: ReturnType<typeof db>) {
  const genreRows = await d.select().from(genres);
  const genreBySlug = Object.fromEntries(genreRows.map((r) => [r.slug, r]));

  for (const [genreSlug, stemTypes] of Object.entries(GENRE_STEMS)) {
    const genre = genreBySlug[genreSlug];
    if (!genre) continue;

    const existingPacks = await d
      .select({ id: samplePacks.id, kind: samplePacks.kind })
      .from(samplePacks)
      .where(eq(samplePacks.genreId, genre.id));

    const poolCount = existingPacks.filter((r) => r.kind === 'pool').length;
    if (poolCount > 0) {
      console.log(`[seed] pool stems for "${genreSlug}" already exist — skipping`);
      continue;
    }

    console.log(`[seed] seeding pool stems for "${genreSlug}"…`);
    for (let packIdx = 0; packIdx < PACKS_PER_GENRE; packIdx++) {
      const packLabel = String.fromCharCode(65 + packIdx);
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
        name: `${genreSlug}-pool-${packLabel}`,
        samples,
      });
    }
  }
}

async function main() {
  const d = db();

  console.log('[seed] system genres…');
  for (const g of MVP_SYSTEM_GENRES) {
    await d
      .insert(genres)
      .values({
        slug: g.slug,
        name: g.name,
        kind: 'system',
        formatConfig: g.formatConfig,
        status: 'active',
      })
      .onConflictDoNothing({ target: genres.slug });
  }

  const genreRows = await d.select().from(genres);
  const genreBySlug = Object.fromEntries(genreRows.map((r) => [r.slug, r]));

  console.log('[seed] demo producers…');
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
        bio: `${u.handle} — demo producer`,
        openToAr: true,
      })
      .onConflictDoNothing({ target: producerProfiles.userId });
  }

  console.log('[seed] demo match + submissions…');
  // Finished 1v1 phonk match. Two producers, two submissions.
  const phonk = genreBySlug['phonk'];
  if (!phonk) throw new Error('phonk genre missing after seed');

  // Check if we've already seeded the match.
  const existing = await d
    .select()
    .from(matches)
    .where(sql`${matches.roomCode} = 'DEMO01'`);
  if (existing.length > 0) {
    console.log('[seed] demo match already exists — skipping');
    console.log('[seed] done.');
    process.exit(0);
  }

  const poly = userByHandle['polystalgia'];
  const knx = userByHandle['knxwnoise'];
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

  // Public-domain demo audio. SoundHelix tracks are CORS-friendly.
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

  // Solo practice-mode submission in house for variety.
  const house = genreBySlug['house'];
  const mayflower = userByHandle['mayflower'];
  const kickrush = userByHandle['dj_kickrush'];
  if (!house || !mayflower || !kickrush) {
    console.log('[seed] done (partial).');
    process.exit(0);
  }

  const [match2] = await d
    .insert(matches)
    .values({
      mode: 'practice',
      status: 'results',
      roomCode: 'DEMO02',
      hostId: mayflower.id,
      teamSize: 1,
      teamCount: 2,
      primaryGenreId: house.id,
      submitSeconds: 1200,
      startedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      endedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 40 * 60 * 1000),
    })
    .returning();
  if (!match2) throw new Error('match2 insert failed');

  const [team2A, team2B] = await d
    .insert(matchTeams)
    .values([
      { matchId: match2.id, seat: 0, name: 'A', finalRank: 1 },
      { matchId: match2.id, seat: 1, name: 'B', finalRank: 2 },
    ])
    .returning();
  if (!team2A || !team2B) throw new Error('match2 teams insert failed');

  await d.insert(matchPlayers).values([
    { matchId: match2.id, userId: mayflower.id, teamId: team2A.id, finalRank: 1 },
    { matchId: match2.id, userId: kickrush.id, teamId: team2B.id, finalRank: 2 },
  ]);

  await d.insert(submissions).values([
    {
      matchId: match2.id,
      userId: mayflower.id,
      genreId: house.id,
      audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
      durationSec: 498,
      title: 'deep cut',
      description: 'deep house groove, vocal chops',
      finalRank: 1,
      score: '0.71',
      plays: 201,
      likes: 42,
      isPublic: true,
    },
    {
      matchId: match2.id,
      userId: kickrush.id,
      genreId: house.id,
      audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3',
      durationSec: 354,
      title: 'warehouse',
      description: 'tech house, club-ready',
      finalRank: 2,
      score: '0.29',
      plays: 83,
      likes: 12,
      isPublic: true,
    },
  ]);

  // Seed pool sample packs if they are missing.
  console.log('[seed] pool sample packs…');
  await seedStems(d);

  console.log('[seed] done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
