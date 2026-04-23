// GET /daily-challenge
//
// Returns (or lazily creates) the single shared match for today's UTC date.
// Callers get back the room code, genre, sample pack, and submission count so
// the /play tile can show social proof and navigate straight into the room.
//
// Design decisions:
// - One match per UTC date. Enforced by the partial unique index on
//   matches.daily_date WHERE daily_date IS NOT NULL.
// - The genre + pack are chosen deterministically by an FNV-1a hash of the
//   date string so every replica agrees without coordination.
// - Race conditions on creation are handled with INSERT ... ON CONFLICT DO
//   NOTHING followed by a re-select.
// - The match starts in 'submit' status (no lobby phase). team_count=20
//   represents the max submitters cap. team_size=1 (each submitter is solo).
// - Yesterday's (and older) daily matches are transitioned to 'results' at
//   rollover - see the daily rollover check in realtime/tick.ts.
// - Votes on results-status daily matches remain open indefinitely (no phase
//   gate in the vote endpoint for mode='daily').

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { genres, matches, samplePacks } from '../db/schema.js';

export const dailyChallengeRoutes = new OpenAPIHono();

const DAILY_CAP = 20;

const DailyChallengeResponse = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    genre: z.object({
      id: z.string().uuid(),
      slug: z.string(),
      name: z.string(),
      stemTypes: z.array(z.string()).nullable(),
    }),
    samplePack: z
      .object({
        id: z.string().uuid(),
        name: z.string(),
      })
      .nullable(),
    roomCode: z.string(),
    submissionCount: z.number().int(),
    cap: z.number().int(),
  })
  .openapi('DailyChallenge');

const route = createRoute({
  method: 'get',
  path: '/daily-challenge',
  tags: ['daily-challenge'],
  summary: "Today's shared daily match - rotates at 00:00 UTC",
  responses: {
    200: {
      description: "The current day's challenge match",
      content: { 'application/json': { schema: DailyChallengeResponse } },
    },
    503: { description: 'No active genres configured' },
  },
});

// FNV-1a 32-bit hash - small, deterministic, no dependencies.
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function utcDateStr(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function randomRoomCode(len = 6): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  let code = '';
  for (let i = 0; i < len; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

dailyChallengeRoutes.openapi(route, async (c) => {
  const d = db();
  const date = utcDateStr();

  // Pick from active system genres only - user-proposed genres aren't
  // stable enough to anchor a shared daily prompt.
  const genreRows = await d
    .select()
    .from(genres)
    .where(and(eq(genres.kind, 'system'), eq(genres.status, 'active')))
    .orderBy(genres.slug);
  const genre = genreRows[hashString(date) % genreRows.length];
  if (!genre) {
    throw new HTTPException(503, { message: 'No active system genres to pick from.' });
  }

  // Pick a pool pack for this genre. Pool packs are system-seeded.
  const packRows = await d
    .select({ id: samplePacks.id, name: samplePacks.name })
    .from(samplePacks)
    .where(and(eq(samplePacks.genreId, genre.id), eq(samplePacks.kind, 'pool')));
  const samplePack =
    packRows.length > 0 ? (packRows[hashString(`${date}:pack`) % packRows.length] ?? null) : null;

  // Find or create the match for today. Use INSERT ... ON CONFLICT DO NOTHING
  // to handle the race where two requests arrive simultaneously.
  let existingMatch = await d
    .select()
    .from(matches)
    .where(eq(matches.dailyDate, date))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!existingMatch) {
    // Try to create. Retry room code on collision (unique constraint on room_code).
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomRoomCode();
      const inserted = await d
        .insert(matches)
        .values({
          mode: 'daily',
          status: 'submit',
          roomCode: code,
          // teamSize/teamCount don't drive logic for daily matches; set to 1/1
          // to satisfy the DB check constraints. The 20-submitter cap is
          // enforced by application logic in POST /rooms/:code/submission.
          teamSize: 1,
          teamCount: 1,
          primaryGenreId: genre.id,
          samplePackId: samplePack?.id ?? null,
          sampleMode: samplePack ? 'generated' : 'none',
          // submitSeconds is NULL for daily matches - there is no timed submission
          // phase. The match stays in 'submit' until the UTC date rolls over.
          submitSeconds: null,
          dailyDate: date,
        })
        .onConflictDoNothing()
        .returning();

      if (inserted.length > 0) {
        existingMatch = inserted[0] ?? null;
        break;
      }

      // ON CONFLICT could fire on either room_code or daily_date. Re-select
      // to get whatever row won the race.
      existingMatch = await d
        .select()
        .from(matches)
        .where(eq(matches.dailyDate, date))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (existingMatch) break;
    }
  }

  if (!existingMatch?.roomCode) {
    throw new HTTPException(500, { message: 'Could not resolve daily match.' });
  }

  // Count distinct submitters for this match.
  const countRows = await d.execute<{ n: number }>(
    sql`SELECT COUNT(DISTINCT user_id)::int AS n FROM submissions WHERE match_id = ${existingMatch.id}`,
  );
  const submissionCount = (countRows[0] as { n: number } | undefined)?.n ?? 0;

  return c.json(
    {
      date,
      genre: {
        id: genre.id,
        slug: genre.slug,
        name: genre.name,
        stemTypes: genre.stemTypes ?? null,
      },
      samplePack,
      roomCode: existingMatch.roomCode,
      submissionCount,
      cap: DAILY_CAP,
    },
    200,
  );
});
