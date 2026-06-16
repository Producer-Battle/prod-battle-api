// Sample Flip source library: public read + community submission/voting.
// Producers can submit a loop (upload), the community upvotes, and an A&R/admin
// approves it in the review queue (routes/review.ts) before it becomes usable.
// Admin generation lives in admin-flip-sources.ts.

import { randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, sql } from 'drizzle-orm';
import { bucket, publicUrl, s3Public, signUrl } from '../audio/s3.js';
import { db } from '../db/client.js';
import { flipSourceVotes, flipSources, genres } from '../db/schema.js';
import { requireProducerQuota } from '../middleware/rate-limit.js';

export const flipSourcesRoutes = new OpenAPIHono();

// Daily submit quota for community flip submissions (free 5 / paid 25).
flipSourcesRoutes.use('/flip-sources', requireProducerQuota('flip'));

const ErrorBody = z.object({ error: z.string(), message: z.string() });
const PRESIGN_TTL_SEC = 600; // 10 min upload window
const AUDIO_EXT: Record<string, string> = {
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/ogg': '.ogg',
};

const FlipSourceRow = z.object({
  id: z.string().uuid(),
  label: z.string(),
  genreSlug: z.string().nullable(),
  url: z.string().url(),
  durationSec: z.number().int().nullable(),
  voteCount: z.number().int(),
  myVote: z.boolean(),
});

// ─── GET /flip-sources (active sources + vote counts) ────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/flip-sources',
  tags: ['flip-sources'],
  summary: 'Active flip sources - optionally filtered by genre',
  request: { query: z.object({ genreSlug: z.string().optional() }) },
  responses: {
    200: {
      description: 'Active flip sources',
      content: { 'application/json': { schema: z.object({ items: z.array(FlipSourceRow) }) } },
    },
  },
});

flipSourcesRoutes.openapi(listRoute, async (c) => {
  const { genreSlug } = c.req.valid('query');
  const d = db();
  const userId = c.var.user?.id ?? null;

  let genreId: string | null = null;
  if (genreSlug) {
    const [g] = await d.select().from(genres).where(eq(genres.slug, genreSlug)).limit(1);
    genreId = g?.id ?? null;
    if (!genreId) return c.json({ items: [] }, 200);
  }

  const rows = await d
    .select({
      id: flipSources.id,
      label: flipSources.label,
      genreSlug: genres.slug,
      url: flipSources.url,
      durationSec: flipSources.durationSec,
      voteCount: sql<number>`(SELECT count(*)::int FROM flip_source_votes v WHERE v.flip_source_id = ${flipSources.id})`,
      myVote: userId
        ? sql<boolean>`EXISTS (SELECT 1 FROM flip_source_votes v WHERE v.flip_source_id = ${flipSources.id} AND v.voter_id = ${userId})`
        : sql<boolean>`false`,
    })
    .from(flipSources)
    .leftJoin(genres, eq(genres.id, flipSources.genreId))
    .where(
      genreId
        ? and(eq(flipSources.active, true), eq(flipSources.genreId, genreId))
        : eq(flipSources.active, true),
    )
    .orderBy(desc(flipSources.createdAt));

  const items = await Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      label: r.label,
      genreSlug: r.genreSlug ?? null,
      url: await signUrl(r.url, 3600),
      durationSec: r.durationSec ?? null,
      voteCount: Number(r.voteCount ?? 0),
      myVote: Boolean(r.myVote),
    })),
  );

  return c.json({ items }, 200);
});

// ─── POST /flip-sources/upload-url (presign one loop) ────────────────────────

const uploadUrlRoute = createRoute({
  method: 'post',
  path: '/flip-sources/upload-url',
  tags: ['flip-sources'],
  summary: 'Presign a single flip-loop upload',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            filename: z.string().min(1).max(128),
            contentType: z.string().min(3).max(64),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Presigned upload handle',
      content: {
        'application/json': {
          schema: z.object({
            uploadUrl: z.string().url(),
            publicUrl: z.string().url(),
            key: z.string(),
          }),
        },
      },
    },
    400: {
      description: 'Unsupported type',
      content: { 'application/json': { schema: ErrorBody } },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorBody } } },
  },
});

flipSourcesRoutes.openapi(uploadUrlRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);
  const { contentType } = c.req.valid('json');
  const ext = AUDIO_EXT[contentType.toLowerCase()];
  if (!ext) return c.json({ error: 'bad_type', message: 'Upload a WAV, MP3, or OGG loop.' }, 400);

  const key = `flips/user/${randomUUID()}${ext}`;
  const uploadUrl = await getSignedUrl(
    s3Public(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    { expiresIn: PRESIGN_TTL_SEC },
  );
  return c.json({ uploadUrl, publicUrl: publicUrl(key), key }, 200);
});

// ─── POST /flip-sources (finalize submission, pending review) ────────────────

const submitRoute = createRoute({
  method: 'post',
  path: '/flip-sources',
  tags: ['flip-sources'],
  summary: 'Submit a flip loop for community voting + A&R/admin review',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            label: z.string().min(2).max(80),
            genreId: z.string().uuid().optional(),
            url: z.string().url(),
            durationSec: z.number().int().min(1).max(600).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Submitted (pending review)',
      content: { 'application/json': { schema: z.object({ id: z.string().uuid() }) } },
    },
    400: { description: 'Invalid genre', content: { 'application/json': { schema: ErrorBody } } },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorBody } } },
  },
});

flipSourcesRoutes.openapi(submitRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);
  const body = c.req.valid('json');
  const d = db();

  if (body.genreId) {
    const [g] = await d
      .select({ id: genres.id })
      .from(genres)
      .where(eq(genres.id, body.genreId))
      .limit(1);
    if (!g) return c.json({ error: 'genre_not_found', message: 'No such genre.' }, 400);
  }

  const [row] = await d
    .insert(flipSources)
    .values({
      label: body.label,
      genreId: body.genreId ?? null,
      url: body.url,
      source: 'upload',
      durationSec: body.durationSec ?? null,
      active: false, // hidden until an A&R/admin approves it
      reviewedAt: null,
      createdBy: user.id,
    })
    .returning({ id: flipSources.id });
  if (!row) return c.json({ error: 'insert_failed', message: 'Could not submit.' }, 400);
  return c.json({ id: row.id }, 201);
});

// ─── POST /flip-sources/:id/vote (community upvote, idempotent) ───────────────

const voteRoute = createRoute({
  method: 'post',
  path: '/flip-sources/{id}/vote',
  tags: ['flip-sources'],
  summary: 'Upvote a flip source',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Voted',
      content: {
        'application/json': { schema: z.object({ voted: z.literal(true), voteCount: z.number() }) },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorBody } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorBody } } },
  },
});

flipSourcesRoutes.openapi(voteRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);
  const { id } = c.req.valid('param');
  const d = db();

  const [src] = await d
    .select({ id: flipSources.id })
    .from(flipSources)
    .where(eq(flipSources.id, id))
    .limit(1);
  if (!src) return c.json({ error: 'not_found', message: 'No such flip source.' }, 404);

  await d
    .insert(flipSourceVotes)
    .values({ flipSourceId: id, voterId: user.id })
    .onConflictDoNothing();

  const counts = await d
    .select({ n: sql<number>`count(*)::int` })
    .from(flipSourceVotes)
    .where(eq(flipSourceVotes.flipSourceId, id));
  return c.json({ voted: true as const, voteCount: Number(counts[0]?.n ?? 0) }, 200);
});
