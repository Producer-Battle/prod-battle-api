// Shared A&R + admin review queue for community submissions: pending Sample
// Flip loops and uploaded sample packs awaiting promotion to the shared pool.
// Votes inform; an A&R or admin makes the final call here.

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import { signUrl } from '../audio/s3.js';
import { db } from '../db/client.js';
import { flipSources, samplePacks } from '../db/schema.js';

export const reviewRoutes = new OpenAPIHono();

const ErrorBody = z.object({ error: z.string(), message: z.string() });

type Guard =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; body: { error: string; message: string } };

// A&R or admin only (mirrors requireAr in ar-engagement.ts).
function requireReviewer(c: Context): Guard {
  const user = c.var.user;
  if (!user)
    return { ok: false, status: 401, body: { error: 'unauthenticated', message: 'Sign in.' } };
  if (user.role !== 'ar' && user.role !== 'admin')
    return {
      ok: false,
      status: 403,
      body: { error: 'forbidden', message: 'A&R or admin role required.' },
    };
  return { ok: true, userId: user.id };
}

const FlipItem = z.object({
  id: z.string().uuid(),
  label: z.string(),
  url: z.string().url(),
  genreSlug: z.string().nullable(),
  submitterHandle: z.string().nullable(),
  voteCount: z.number().int(),
  createdAt: z.string().datetime(),
});
const PackItem = z.object({
  id: z.string().uuid(),
  name: z.string(),
  genreSlug: z.string(),
  stemCount: z.number().int(),
  submitterHandle: z.string().nullable(),
  voteCount: z.number().int(),
  createdAt: z.string().datetime(),
});

// ─── GET /review/queue ───────────────────────────────────────────────────────

const queueRoute = createRoute({
  method: 'get',
  path: '/review/queue',
  tags: ['review'],
  summary: 'Pending community submissions (A&R/admin)',
  responses: {
    200: {
      description: 'Pending flips + packs',
      content: {
        'application/json': {
          schema: z.object({ flips: z.array(FlipItem), packs: z.array(PackItem) }),
        },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorBody } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorBody } } },
  },
});

reviewRoutes.openapi(queueRoute, async (c) => {
  const g = requireReviewer(c);
  if (!g.ok) return c.json(g.body, g.status);
  const d = db();

  const flipRows = await d.execute<{
    id: string;
    label: string;
    url: string;
    genre_slug: string | null;
    submitter_handle: string | null;
    vote_count: number;
    created_at: string;
  }>(`
    SELECT f.id, f.label, f.url, g.slug AS genre_slug, u.handle AS submitter_handle,
           (SELECT count(*)::int FROM flip_source_votes v WHERE v.flip_source_id = f.id) AS vote_count,
           f.created_at
      FROM flip_sources f
      LEFT JOIN genres g ON g.id = f.genre_id
      LEFT JOIN users u ON u.id = f.created_by
     WHERE f.active = false AND f.reviewed_at IS NULL AND f.created_by IS NOT NULL
     ORDER BY vote_count DESC, f.created_at ASC
     LIMIT 100`);

  const packRows = await d.execute<{
    id: string;
    name: string;
    genre_slug: string;
    stem_count: number;
    submitter_handle: string | null;
    vote_count: number;
    created_at: string;
  }>(`
    SELECT p.id, p.name, g.slug AS genre_slug,
           jsonb_array_length(p.samples)::int AS stem_count,
           u.handle AS submitter_handle,
           (SELECT count(*)::int FROM sample_pack_votes v WHERE v.pack_id = p.id) AS vote_count,
           p.created_at
      FROM sample_packs p
      JOIN genres g ON g.id = p.genre_id
      LEFT JOIN users u ON u.id = p.created_by
     WHERE p.kind = 'uploaded' AND p.reviewed_at IS NULL
     ORDER BY vote_count DESC, p.created_at ASC
     LIMIT 100`);

  const flips = await Promise.all(
    (flipRows as Array<Record<string, unknown>>).map(async (r) => ({
      id: r.id as string,
      label: r.label as string,
      url: await signUrl(r.url as string, 3600),
      genreSlug: (r.genre_slug as string | null) ?? null,
      submitterHandle: (r.submitter_handle as string | null) ?? null,
      voteCount: Number(r.vote_count ?? 0),
      createdAt: new Date(r.created_at as string).toISOString(),
    })),
  );
  const packs = (packRows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    genreSlug: r.genre_slug as string,
    stemCount: Number(r.stem_count ?? 0),
    submitterHandle: (r.submitter_handle as string | null) ?? null,
    voteCount: Number(r.vote_count ?? 0),
    createdAt: new Date(r.created_at as string).toISOString(),
  }));

  return c.json({ flips, packs }, 200);
});

// ─── POST /review/flip-sources/:id ───────────────────────────────────────────

const decideBody = z.object({ approve: z.boolean() });

const reviewFlipRoute = createRoute({
  method: 'post',
  path: '/review/flip-sources/{id}',
  tags: ['review'],
  summary: 'Approve or reject a submitted flip source',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: decideBody } } },
  },
  responses: {
    200: {
      description: 'Decided',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorBody } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorBody } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorBody } } },
  },
});

reviewRoutes.openapi(reviewFlipRoute, async (c) => {
  const g = requireReviewer(c);
  if (!g.ok) return c.json(g.body, g.status);
  const { id } = c.req.valid('param');
  const { approve } = c.req.valid('json');
  const d = db();

  const res = await d
    .update(flipSources)
    .set({ active: approve, reviewedAt: new Date(), reviewedBy: g.userId })
    .where(and(eq(flipSources.id, id), isNull(flipSources.reviewedAt)))
    .returning({ id: flipSources.id });
  if (res.length === 0)
    return c.json({ error: 'not_found', message: 'Not pending or missing.' }, 404);
  return c.json({ ok: true as const }, 200);
});

// ─── POST /review/packs/:id ──────────────────────────────────────────────────

const reviewPackRoute = createRoute({
  method: 'post',
  path: '/review/packs/{id}',
  tags: ['review'],
  summary: 'Approve (promote to pool) or reject an uploaded pack',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: decideBody } } },
  },
  responses: {
    200: {
      description: 'Decided',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorBody } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorBody } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorBody } } },
  },
});

reviewRoutes.openapi(reviewPackRoute, async (c) => {
  const g = requireReviewer(c);
  if (!g.ok) return c.json(g.body, g.status);
  const { id } = c.req.valid('param');
  const { approve } = c.req.valid('json');
  const d = db();

  // Approve promotes the uploaded pack into the shared pool; reject just
  // clears it from the queue (it stays the uploader's private pack).
  const res = await d
    .update(samplePacks)
    .set({
      ...(approve ? { kind: 'pool' as const } : {}),
      reviewedAt: new Date(),
      reviewedBy: g.userId,
    })
    .where(
      and(eq(samplePacks.id, id), eq(samplePacks.kind, 'uploaded'), isNull(samplePacks.reviewedAt)),
    )
    .returning({ id: samplePacks.id });
  if (res.length === 0)
    return c.json({ error: 'not_found', message: 'Not pending or missing.' }, 404);
  return c.json({ ok: true as const }, 200);
});
