import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq } from 'drizzle-orm';
import { signUrl } from '../audio/s3.js';
import { db } from '../db/client.js';
import { genres, submissions, users } from '../db/schema.js';

export const feedRoutes = new OpenAPIHono();

const FeedItem = z
  .object({
    id: z.string().uuid(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    audioUrl: z.string().url(),
    waveformUrl: z.string().url().nullable(),
    durationSec: z.number().int().nullable(),
    score: z.number(),
    plays: z.number().int(),
    likes: z.number().int(),
    finalRank: z.number().int().nullable(),
    createdAt: z.string(),
    producer: z.object({
      handle: z.string(),
      avatarUrl: z.string().url().nullable(),
      isSupporter: z.boolean(),
    }),
    genre: z.object({
      slug: z.string(),
      name: z.string(),
    }),
    matchRoomCode: z.string().nullable(),
  })
  .openapi('FeedItem');

const FeedResponse = z.object({ items: z.array(FeedItem) }).openapi('FeedResponse');

const route = createRoute({
  method: 'get',
  path: '/feed',
  tags: ['feed'],
  summary: 'Trending public submissions',
  request: {
    query: z.object({
      genre: z.string().optional().openapi({ example: 'phonk' }),
      limit: z.coerce.number().int().min(1).max(50).optional().default(20),
    }),
  },
  responses: {
    200: {
      description: 'Feed items, newest first',
      content: { 'application/json': { schema: FeedResponse } },
    },
  },
});

feedRoutes.openapi(route, async (c) => {
  const { genre, limit } = c.req.valid('query');
  const d = db();

  const rows = await d
    .select({
      id: submissions.id,
      title: submissions.title,
      description: submissions.description,
      audioUrl: submissions.audioUrl,
      waveformUrl: submissions.waveformUrl,
      durationSec: submissions.durationSec,
      score: submissions.score,
      plays: submissions.plays,
      likes: submissions.likes,
      finalRank: submissions.finalRank,
      createdAt: submissions.createdAt,
      userHandle: users.handle,
      userAvatar: users.avatarUrl,
      userPlan: users.plan,
      genreSlug: genres.slug,
      genreName: genres.name,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.userId))
    .innerJoin(genres, eq(genres.id, submissions.genreId))
    // Winners only on the feed: anything that finished in 1st place. Other
    // entries stay on producer profiles, just not in the global discovery
    // feed (keeps the feed signal high - only beats that beat the room).
    .where(
      genre
        ? and(eq(submissions.isPublic, true), eq(submissions.finalRank, 1), eq(genres.slug, genre))
        : and(eq(submissions.isPublic, true), eq(submissions.finalRank, 1)),
    )
    .orderBy(desc(submissions.createdAt))
    .limit(limit);

  // Sign audio URLs so they play from the private Scaleway bucket.
  // signUrl() passes through external URLs (e.g. the SoundHelix demo
  // tracks used for the initial seed) unchanged.
  const items = await Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      audioUrl: await signUrl(r.audioUrl),
      waveformUrl: r.waveformUrl ? await signUrl(r.waveformUrl) : null,
      durationSec: r.durationSec,
      score: Number(r.score),
      plays: r.plays,
      likes: r.likes,
      finalRank: r.finalRank,
      createdAt: r.createdAt.toISOString(),
      producer: {
        handle: r.userHandle,
        avatarUrl: r.userAvatar,
        isSupporter: r.userPlan === 'paid',
      },
      genre: { slug: r.genreSlug, name: r.genreName },
      matchRoomCode: null,
    })),
  );
  return c.json({ items });
});
