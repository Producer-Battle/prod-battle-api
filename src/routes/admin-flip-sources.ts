// Admin routes for managing the Sample Flip source library.
//
// Flip sources are single loops (vocal chops, melody loops, 8-16 bar
// excerpts) that producers remix in Sample Flip matches. Sourced from
// Freesound CC0 so we can redistribute without per-loop attribution.
//
// S3 layout: flip/{id}.wav - deliberately separate from stems/{genre}/...
// so Sample Flip content can be audited, wiped, or mirrored independently
// from the pack pool.
//
// All routes require role='admin'. Generation is synchronous and
// rate-limited by count; the admin picks how many loops per run.

import { randomUUID } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { desc, eq } from 'drizzle-orm';
import { oggToWav } from '../audio/convert.js';
import { downloadPreview, searchStems } from '../audio/freesound.js';
import { publicUrl, putObject } from '../audio/s3.js';
import { db } from '../db/client.js';
import { flipSources, genres } from '../db/schema.js';

export const adminFlipSourcesRoutes = new OpenAPIHono();

const AdminError = z.object({ error: z.string(), message: z.string() });

const requireAdmin = (
  c: Parameters<Parameters<typeof adminFlipSourcesRoutes.openapi>[1]>[0],
):
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; body: { error: string; message: string } } => {
  const user = c.var.user;
  if (!user)
    return { ok: false, status: 401, body: { error: 'unauthenticated', message: 'Sign in.' } };
  if (user.role !== 'admin')
    return {
      ok: false,
      status: 403,
      body: { error: 'forbidden', message: 'Admin role required.' },
    };
  return { ok: true, userId: user.id };
};

const FlipSourceRow = z.object({
  id: z.string().uuid(),
  label: z.string(),
  genreSlug: z.string().nullable(),
  url: z.string().url(),
  source: z.string(),
  sourceId: z.string().nullable(),
  durationSec: z.number().int().nullable(),
  active: z.boolean(),
  createdAt: z.string(),
});

// ─── GET /admin/flip-sources ────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/admin/flip-sources',
  tags: ['admin', 'flip-sources'],
  summary: 'List flip sources (newest first)',
  responses: {
    200: {
      description: 'Flip sources',
      content: { 'application/json': { schema: z.object({ items: z.array(FlipSourceRow) }) } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
  },
});

adminFlipSourcesRoutes.openapi(listRoute, async (c) => {
  const guard = requireAdmin(c);
  if (!guard.ok) return c.json(guard.body, guard.status);

  const rows = await db()
    .select({
      id: flipSources.id,
      label: flipSources.label,
      genreSlug: genres.slug,
      url: flipSources.url,
      source: flipSources.source,
      sourceId: flipSources.sourceId,
      durationSec: flipSources.durationSec,
      active: flipSources.active,
      createdAt: flipSources.createdAt,
    })
    .from(flipSources)
    .leftJoin(genres, eq(genres.id, flipSources.genreId))
    .orderBy(desc(flipSources.createdAt));

  return c.json(
    {
      items: rows.map((r) => ({
        ...r,
        genreSlug: r.genreSlug ?? null,
        sourceId: r.sourceId ?? null,
        durationSec: r.durationSec ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    },
    200,
  );
});

// ─── POST /admin/flip-sources/generate ──────────────────────────────────────

const generateRoute = createRoute({
  method: 'post',
  path: '/admin/flip-sources/generate',
  tags: ['admin', 'flip-sources'],
  summary: 'Pull flip-worthy loops from Freesound and ingest them',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            // Freesound query string. Good defaults the admin can pick from:
            //   "vocal chop loop"      - melodic vocals
            //   "soul sample loop"     - old-school chops
            //   "melody loop 90 bpm"   - melodic starts
            //   "guitar loop 120 bpm"  - live-instrument flips
            query: z.string().min(2).max(200),
            // Optional tag - lets admins bucket loops by genre even though
            // flip matches stay genre-flexible by default.
            genreSlug: z.string().optional(),
            count: z.number().int().min(1).max(10).default(5),
            minDurationSec: z.number().int().min(2).max(60).default(4),
            maxDurationSec: z.number().int().min(4).max(120).default(16),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Ingested sources',
      content: {
        'application/json': {
          schema: z.object({
            ingested: z.number().int(),
            skipped: z.number().int(),
            items: z.array(FlipSourceRow),
          }),
        },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
    400: { description: 'Bad request', content: { 'application/json': { schema: AdminError } } },
  },
});

adminFlipSourcesRoutes.openapi(generateRoute, async (c) => {
  const guard = requireAdmin(c);
  if (!guard.ok) return c.json(guard.body, guard.status);

  const body = c.req.valid('json');
  const d = db();

  let genreId: string | null = null;
  if (body.genreSlug) {
    const [g] = await d.select().from(genres).where(eq(genres.slug, body.genreSlug)).limit(1);
    if (!g)
      return c.json(
        { error: 'unknown_genre', message: `No genre with slug ${body.genreSlug}` },
        400,
      );
    genreId = g.id;
  }

  // Always start at page 1. searchStems shuffles results internally so
  // variety comes from the shuffle, not from skipping to a random page.
  // Picking page 2/3 for queries with few CC0 results causes a 404 from
  // Freesound (count < page_size means there is only ever page 1).
  const hits = await searchStems({
    query: body.query,
    count: body.count,
    minDurationSec: body.minDurationSec,
    maxDurationSec: body.maxDurationSec,
    page: 1,
  });

  let skipped = 0;
  const inserted: Array<typeof FlipSourceRow._type> = [];
  for (const hit of hits) {
    // Dedup on (source, source_id) so re-runs don't duplicate rows.
    const freesoundId = String(hit.id);
    const [existing] = await d
      .select({ id: flipSources.id })
      .from(flipSources)
      .where(eq(flipSources.sourceId, freesoundId))
      .limit(1);
    if (existing) {
      skipped++;
      continue;
    }

    try {
      const ogg = await downloadPreview(hit);
      const wav = await oggToWav(ogg);
      const id = randomUUID();
      const key = `flips/${id}.wav`;
      await putObject(key, Buffer.from(wav), 'audio/wav');
      const url = publicUrl(key);

      const [row] = await d
        .insert(flipSources)
        .values({
          id,
          label: hit.name.slice(0, 120),
          genreId,
          url,
          source: 'freesound',
          sourceId: freesoundId,
          durationSec: Math.round(hit.durationSec),
          active: true,
          createdBy: guard.userId,
        })
        .returning();
      if (!row) continue;

      inserted.push({
        id: row.id,
        label: row.label,
        genreSlug: body.genreSlug ?? null,
        url: row.url,
        source: row.source,
        sourceId: row.sourceId,
        durationSec: row.durationSec,
        active: row.active,
        createdAt: row.createdAt.toISOString(),
      });
    } catch (e) {
      console.error(`[admin-flip] failed to ingest freesound#${hit.id}:`, e);
      skipped++;
    }
  }

  return c.json({ ingested: inserted.length, skipped, items: inserted }, 200);
});

// ─── PATCH /admin/flip-sources/:id ──────────────────────────────────────────

const toggleRoute = createRoute({
  method: 'patch',
  path: '/admin/flip-sources/{id}',
  tags: ['admin', 'flip-sources'],
  summary: 'Toggle a flip source active/inactive',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': { schema: z.object({ active: z.boolean() }) },
      },
    },
  },
  responses: {
    200: { description: 'Updated', content: { 'application/json': { schema: FlipSourceRow } } },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
    404: { description: 'Not found', content: { 'application/json': { schema: AdminError } } },
  },
});

adminFlipSourcesRoutes.openapi(toggleRoute, async (c) => {
  const guard = requireAdmin(c);
  if (!guard.ok) return c.json(guard.body, guard.status);
  const { id } = c.req.valid('param');
  const { active } = c.req.valid('json');

  const [row] = await db()
    .update(flipSources)
    .set({ active })
    .where(eq(flipSources.id, id))
    .returning();
  if (!row) return c.json({ error: 'not_found', message: 'Flip source not found.' }, 404);

  const [withGenre] = await db()
    .select({
      id: flipSources.id,
      label: flipSources.label,
      genreSlug: genres.slug,
      url: flipSources.url,
      source: flipSources.source,
      sourceId: flipSources.sourceId,
      durationSec: flipSources.durationSec,
      active: flipSources.active,
      createdAt: flipSources.createdAt,
    })
    .from(flipSources)
    .leftJoin(genres, eq(genres.id, flipSources.genreId))
    .where(eq(flipSources.id, id))
    .limit(1);
  if (!withGenre) return c.json({ error: 'not_found', message: 'Flip source not found.' }, 404);

  return c.json(
    {
      id: withGenre.id,
      label: withGenre.label,
      genreSlug: withGenre.genreSlug ?? null,
      url: withGenre.url,
      source: withGenre.source,
      sourceId: withGenre.sourceId ?? null,
      durationSec: withGenre.durationSec ?? null,
      active: withGenre.active,
      createdAt: withGenre.createdAt.toISOString(),
    },
    200,
  );
});

// ─── DELETE /admin/flip-sources/:id ─────────────────────────────────────────

const deleteRoute = createRoute({
  method: 'delete',
  path: '/admin/flip-sources/{id}',
  tags: ['admin', 'flip-sources'],
  summary: 'Delete a flip source row (does not wipe S3; set inactive first if unsure)',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    204: { description: 'Deleted' },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
    404: { description: 'Not found', content: { 'application/json': { schema: AdminError } } },
  },
});

adminFlipSourcesRoutes.openapi(deleteRoute, async (c) => {
  const guard = requireAdmin(c);
  if (!guard.ok) return c.json(guard.body, guard.status);
  const { id } = c.req.valid('param');
  const [row] = await db().delete(flipSources).where(eq(flipSources.id, id)).returning();
  if (!row) return c.json({ error: 'not_found', message: 'Flip source not found.' }, 404);
  return c.body(null, 204);
});
