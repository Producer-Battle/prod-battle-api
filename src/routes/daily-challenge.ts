// GET /daily-challenge
//
// One shared prompt per UTC day: "make a beat in <genre> today". No DB
// table, no scheduled job - today's pick is derived deterministically
// from the date so every replica and every reload agrees. Rotation
// happens automatically when the UTC date flips.
//
// Storage-free design was a deliberate trade: we get trivial scaling
// and zero coordination at the cost of being unable to pre-commit a
// specific challenge for a specific day (admin override would need a
// real table). Fine for MVP; revisit once editorial scheduling is
// actually needed.

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { genres, samplePacks } from '../db/schema.js';

export const dailyChallengeRoutes = new OpenAPIHono();

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
  })
  .openapi('DailyChallenge');

const route = createRoute({
  method: 'get',
  path: '/daily-challenge',
  tags: ['daily-challenge'],
  summary: "Today's shared prompt (genre + pack) - rotates at 00:00 UTC",
  responses: {
    200: {
      description: "The current day's challenge",
      content: { 'application/json': { schema: DailyChallengeResponse } },
    },
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

  return c.json({
    date,
    genre: {
      id: genre.id,
      slug: genre.slug,
      name: genre.name,
      stemTypes: genre.stemTypes ?? null,
    },
    samplePack,
  });
});
