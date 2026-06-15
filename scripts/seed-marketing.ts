// Marketing seed: makes the local stack look like a thriving, multi-genre
// platform so the recorded clips are full of life. Idempotent.
//
//   pnpm tsx scripts/seed-marketing.ts
//
// Enriches a roster of demo producers with avatars, honor, ranked tiers
// (spread across genres), achievements, social links and a back-catalogue of
// finished matches + public submissions whose audio is served same-origin
// from the web app (http://localhost:5173/promo/beatN.wav) so the feed +
// profiles render real waveforms. Run AFTER `scripts/seed.ts --with-demo`.

import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import {
  achievements,
  genres,
  matchPlayers,
  matchTeams,
  matches,
  producerProfiles,
  rankings,
  seasons,
  submissions,
  users,
} from '../src/db/schema.js';

const AVATAR = (seed: string) =>
  `https://api.dicebear.com/9.x/thumbs/png?seed=${encodeURIComponent(seed)}&size=240`;
// Same-origin audio so WaveSurfer can decode + draw a waveform (external
// hosts without CORS render only a play button). 8 beats, cycled.
const BEAT = (n: number) => `http://localhost:5173/promo/beat${((n - 1) % 8) + 1}.wav`;

// glicko ratings land in distinct tiers (Bronze 0-100, Silver 100-250,
// Gold 250-500, Plat 500-1000, Diamond 1000-2000, Master 2000-3500).
// Each producer is ranked in 1-2 genres so leaderboards aren't monocultures.
const ROSTER = [
  {
    handle: 'polystalgia', plan: 'paid' as const, honor: 96, accent: '#a855f7',
    bio: 'phonk + memphis vibes. same kit, no excuses. flip everything.',
    socials: { soundcloud: 'https://soundcloud.com/polystalgia', instagram: 'https://instagram.com/polystalgia', spotify: 'https://open.spotify.com/artist/polystalgia' },
    achievements: ['tier_master', 'match_lifetime_100', 'daily_champion', 'genre_mastery_10', 'remix_master_10', 'trusted_honor'],
    ranks: [['phonk', 2680, 41, 14], ['hip-hop-trap', 1380, 22, 12]],
  },
  {
    handle: 'knxwnoise', plan: 'paid' as const, honor: 89, accent: '#22d3ee',
    bio: 'dark trap, cowbell-forward. i sleep on the 808.',
    socials: { soundcloud: 'https://soundcloud.com/knxwnoise', youtube: 'https://youtube.com/@knxwnoise' },
    achievements: ['tier_diamond', 'match_lifetime_100', 'weekly_pick', 'match_streak_7'],
    ranks: [['hip-hop-trap', 1480, 33, 19], ['phonk', 720, 15, 13]],
  },
  {
    handle: 'mayflower', plan: 'free' as const, honor: 78, accent: null,
    bio: 'lo-fi, house, whatever swings. tea then beats.',
    socials: { bandcamp: 'https://mayflower.bandcamp.com' },
    achievements: ['tier_plat', 'active_listener_10', 'votes_lifetime_100'],
    ranks: [['lo-fi', 760, 21, 17], ['house', 430, 11, 10]],
  },
  {
    handle: 'dj_kickrush', plan: 'free' as const, honor: 67, accent: null,
    bio: 'dnb & dubstep. faster, louder, again.',
    socials: { soundcloud: 'https://soundcloud.com/kickrush' },
    achievements: ['tier_gold', 'match_streak_7'],
    ranks: [['drum-and-bass', 380, 14, 16], ['dubstep', 260, 8, 9]],
  },
  {
    handle: 'velour', plan: 'paid' as const, honor: 92, accent: '#f43f5e',
    bio: 'amapiano log drums all day.',
    socials: { instagram: 'https://instagram.com/velour' },
    achievements: ['tier_master', 'season_finalist_top10', 'remix_master_50'],
    ranks: [['amapiano', 3180, 58, 17], ['afro-house', 1650, 26, 14]],
  },
  {
    handle: 'ghostbyte', plan: 'free' as const, honor: 81, accent: null,
    bio: 'techno, hardstyle, no sleep.', socials: {},
    achievements: ['tier_diamond', 'match_lifetime_100'],
    ranks: [['techno', 2050, 30, 21], ['hardstyle', 1120, 18, 15]],
  },
  {
    handle: 'saint_lo', plan: 'free' as const, honor: 73, accent: null,
    bio: 'afro-house warmth.', socials: {},
    achievements: ['tier_plat'], ranks: [['afro-house', 900, 18, 15]],
  },
  {
    handle: 'm0nolith', plan: 'free' as const, honor: 69, accent: null,
    bio: 'minimal, heavy.', socials: {},
    achievements: ['tier_plat', 'match_streak_7'], ranks: [['techno', 520, 12, 13]],
  },
  {
    handle: 'novaa', plan: 'free' as const, honor: 64, accent: null,
    bio: 'just here to flip samples.', socials: {},
    achievements: ['tier_gold'], ranks: [['house', 300, 9, 11]],
  },
] as const;

// Back-catalogue across genres (real audio -> waveforms in feed + profiles).
// [handle, title, beatIdx, score, finalRank, plays, likes, mode, genreSlug]
const TRACKS: Array<[string, string, number, string, number, number, number, string, string]> = [
  ['polystalgia', 'drift drums', 1, '0.71', 1, 1840, 212, 'ranked', 'phonk'],
  ['polystalgia', 'cowbell sermon', 2, '0.66', 1, 1320, 158, 'flip', 'phonk'],
  ['polystalgia', 'midnight memphis', 3, '0.59', 2, 980, 121, 'quickplay', 'hip-hop-trap'],
  ['knxwnoise', 'night ride', 4, '0.63', 1, 1450, 176, 'ranked', 'hip-hop-trap'],
  ['knxwnoise', 'static prayer', 5, '0.55', 2, 870, 99, 'flip', 'phonk'],
  ['mayflower', 'oolong', 6, '0.58', 1, 760, 88, 'quickplay', 'lo-fi'],
  ['mayflower', 'porch light', 7, '0.49', 3, 540, 61, 'ranked', 'house'],
  ['dj_kickrush', 'amen burner', 8, '0.52', 2, 690, 74, 'ranked', 'drum-and-bass'],
  ['velour', 'log drum gospel', 1, '0.69', 1, 1610, 198, 'ranked', 'amapiano'],
  ['velour', 'sgija nights', 2, '0.61', 1, 1180, 140, 'flip', 'afro-house'],
  ['ghostbyte', '303 acid', 3, '0.57', 2, 820, 96, 'ranked', 'techno'],
  ['saint_lo', 'sunrise grooves', 4, '0.5', 2, 470, 55, 'quickplay', 'afro-house'],
  ['m0nolith', 'concrete', 5, '0.46', 3, 360, 41, 'ranked', 'techno'],
  ['novaa', 'first flip', 6, '0.43', 4, 290, 33, 'flip', 'house'],
  ['ghostbyte', 'rave cathedral', 7, '0.54', 1, 910, 112, 'ranked', 'hardstyle'],
  ['dj_kickrush', 'sub bender', 8, '0.48', 3, 430, 47, 'flip', 'dubstep'],
];

async function main() {
  const d = db();

  const [season] = await d
    .select()
    .from(seasons)
    .where(sql`now() >= ${seasons.startsAt} and now() < ${seasons.endsAt}`)
    .limit(1);
  if (!season) throw new Error('no active season for now()');

  const genreRows = await d.select().from(genres);
  const genreBySlug = Object.fromEntries(genreRows.map((g) => [g.slug, g]));
  const need = (slug: string) => {
    const g = genreBySlug[slug];
    if (!g) throw new Error(`genre ${slug} missing - run seed.ts --with-demo first`);
    return g;
  };

  // 1) Ensure every roster user exists + enrich it.
  for (const r of ROSTER) {
    await d
      .insert(users)
      .values({ handle: r.handle, email: `${r.handle}@demo.local`, emailVerified: true })
      .onConflictDoNothing({ target: users.handle });

    const [u] = await d.select().from(users).where(sql`${users.handle} = ${r.handle}`).limit(1);
    if (!u) throw new Error(`user ${r.handle} missing after upsert`);

    await d
      .update(users)
      .set({
        plan: r.plan,
        honor: r.honor,
        calibrationMatchesRemaining: 0,
        avatarUrl: AVATAR(r.handle),
        accentColor: r.accent ?? null,
      })
      .where(sql`${users.id} = ${u.id}`);

    await d
      .insert(producerProfiles)
      .values({ userId: u.id, bio: r.bio, openToAr: true, socialLinks: r.socials })
      .onConflictDoUpdate({ target: producerProfiles.userId, set: { bio: r.bio, socialLinks: r.socials } });

    for (const [slug, glicko, wins, losses] of r.ranks) {
      const g = need(slug as string);
      await d
        .insert(rankings)
        .values({
          userId: u.id, genreId: g.id, seasonId: season.id,
          glickoRating: String(glicko), glickoRd: '90', glickoVolatility: 0.04,
          wins: wins as number, losses: losses as number, updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [rankings.userId, rankings.genreId, rankings.seasonId],
          set: { glickoRating: String(glicko), wins: wins as number, losses: losses as number, updatedAt: new Date() },
        });
    }

    for (const key of r.achievements) {
      await d.insert(achievements).values({ userId: u.id, achievementKey: key }).onConflictDoNothing();
    }
  }

  // 2) Back-catalogue: one finished match per track (match_players is keyed
  //    (match_id, user_id), so a producer appears once per match).
  const userRows = await d.select().from(users);
  const idByHandle = Object.fromEntries(userRows.map((u) => [u.handle, u.id]));

  const existing = await d.select().from(matches).where(sql`${matches.roomCode} = 'MKTG01'`);
  if (existing.length === 0) {
    let i = 0;
    for (const [handle, title, beat, score, rank, plays, likes, mode, gslug] of TRACKS) {
      const uid = idByHandle[handle];
      if (!uid) continue;
      const g = need(gslug);
      i++;
      const code = `MKTG${String(i).padStart(2, '0')}`;
      const ageMs = (i + 1) * 40 * 60 * 1000;
      const [match] = await d
        .insert(matches)
        .values({
          mode: mode as 'quickplay' | 'ranked' | 'flip', status: 'results', roomCode: code, hostId: uid,
          teamSize: 1, teamCount: 8, primaryGenreId: g.id, submitSeconds: 600,
          startedAt: new Date(Date.now() - ageMs - 30 * 60 * 1000),
          endedAt: new Date(Date.now() - ageMs),
        })
        .returning();
      if (!match) continue;
      const [team] = await d
        .insert(matchTeams)
        .values({ matchId: match.id, seat: 0, name: handle, finalRank: rank })
        .returning();
      if (!team) continue;
      await d.insert(matchPlayers).values({ matchId: match.id, userId: uid, teamId: team.id, finalRank: rank });
      await d.insert(submissions).values({
        matchId: match.id, userId: uid, genreId: g.id, audioUrl: BEAT(beat),
        durationSec: 180 + beat * 7, title, description: `${mode} - ${title}`,
        finalRank: rank, score, plays, likes, isPublic: true,
      });
    }
    console.log(`[seed:mktg] ${TRACKS.length} finished matches across genres`);
  } else {
    console.log('[seed:mktg] MKTG* already exists - skipping back-catalogue');
  }

  console.log('[seed:mktg] roster enriched:', ROSTER.map((r) => r.handle).join(', '));
  process.exit(0);
}

main().catch((e) => {
  console.error('[seed:mktg] failed:', e);
  process.exit(1);
});
