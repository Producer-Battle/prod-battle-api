// Seed a finished single-elimination bracket for the "Amapiano Cup #3"
// tournament so the detail page shows real rounds (quarters -> semis -> final)
// with matchups + winners, not just an empty card. Idempotent.
//
//   pnpm tsx scripts/seed-marketing-bracket.ts

import { eq, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { genres, matchPlayers, matches, submissions, tournaments, users } from '../src/db/schema.js';

const MINIO = (n: number) =>
  `http://localhost:9002/prod-battle-local-audio/stems/beat${((n - 1) % 8) + 1}.wav`;

// [round, winnerHandle, loserHandle] - velour runs the table to the title.
const BRACKET: Array<[number, string, string]> = [
  [1, 'velour', 'novaa'],
  [1, 'ghostbyte', 'm0nolith'],
  [1, 'polystalgia', 'mayflower'],
  [1, 'knxwnoise', 'saint_lo'],
  [2, 'velour', 'ghostbyte'],
  [2, 'polystalgia', 'knxwnoise'],
  [3, 'velour', 'polystalgia'],
];

async function main() {
  const d = db();
  const [t] = await d.select().from(tournaments).where(eq(tournaments.name, 'Amapiano Cup #3')).limit(1);
  if (!t) throw new Error('Amapiano Cup #3 not found - run seed-marketing-extra.sql first');
  const [g] = await d.select().from(genres).where(eq(genres.slug, 'amapiano')).limit(1);
  if (!g) throw new Error('amapiano genre missing');
  const idByHandle = Object.fromEntries((await d.select().from(users)).map((u) => [u.handle, u.id]));

  const existing = await d.select().from(matches).where(sql`${matches.tournamentId} = ${t.id}`);
  if (existing.length > 0) {
    console.log('[bracket] already seeded - skipping');
    process.exit(0);
  }

  let i = 0;
  for (const [round, win, lose] of BRACKET) {
    i++;
    const winId = idByHandle[win];
    const loseId = idByHandle[lose];
    if (!winId || !loseId) continue;
    const [m] = await d
      .insert(matches)
      .values({
        mode: 'tournament',
        status: 'results',
        roomCode: `AMACUP${i}`,
        hostId: winId,
        teamSize: 1,
        teamCount: 2,
        primaryGenreId: g.id,
        submitSeconds: 600,
        tournamentId: t.id,
        tournamentRound: round,
        startedAt: new Date(Date.now() - 8 * 86_400_000),
        endedAt: new Date(Date.now() - 8 * 86_400_000 + 3_600_000),
      })
      .returning();
    if (!m) continue;
    await d.insert(matchPlayers).values([
      { matchId: m.id, userId: winId, finalRank: 1 },
      { matchId: m.id, userId: loseId, finalRank: 2 },
    ]);
    await d.insert(submissions).values([
      { matchId: m.id, userId: winId, genreId: g.id, audioUrl: MINIO(i), durationSec: 180, title: `${win} - round ${round}`, finalRank: 1, score: '0.62', isPublic: true },
      { matchId: m.id, userId: loseId, genreId: g.id, audioUrl: MINIO(i + 1), durationSec: 180, title: `${lose} - round ${round}`, finalRank: 2, score: '0.38', isPublic: true },
    ]);
  }
  console.log(`[bracket] seeded ${BRACKET.length} tournament matches for Amapiano Cup #3`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[bracket] failed:', e);
  process.exit(1);
});
