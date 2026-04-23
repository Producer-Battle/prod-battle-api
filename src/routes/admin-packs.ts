// Admin endpoints for managing sample packs.
//
// GET  /admin/sample-packs           - list all packs with genre, kind, count
// POST /admin/sample-packs/:id/regenerate - wipe S3 stems for pack, re-fetch from Freesound
// POST /admin/genres/:id/generate-pool-pack - create a new pool pack for a genre
// DELETE /admin/sample-packs/:id     - delete pack row (S3 objects are left for audit)

import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { generatePackItems } from '../audio/pool-pack-generator.js';
import { bucket, keyFromUrl, s3 } from '../audio/s3.js';
import { db } from '../db/client.js';
import { type SamplePackItem, genres, samplePacks } from '../db/schema.js';
import { GENRE_STEMS } from '../matchmaking/defaults.js';

export const adminPacksRoutes = new OpenAPIHono();

const AdminError = z.object({ error: z.string(), message: z.string() });

const requireAdmin = (
  c: Parameters<Parameters<typeof adminPacksRoutes.openapi>[1]>[0],
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

const PackRow = z.object({
  id: z.string().uuid(),
  genreId: z.string().uuid(),
  genreSlug: z.string(),
  genreName: z.string(),
  kind: z.enum(['uploaded', 'generated', 'pool']),
  name: z.string(),
  stemCount: z.number().int(),
  createdAt: z.string().datetime(),
  createdByHandle: z.string().nullable(),
});

// ─── GET /admin/sample-packs ────────────────────────────────────────────────

const listPacksRoute = createRoute({
  method: 'get',
  path: '/admin/sample-packs',
  tags: ['admin', 'sample-packs'],
  summary: 'List sample packs with genre name, kind, stem count',
  request: {
    query: z.object({
      genreSlug: z.string().optional(),
      kind: z.enum(['uploaded', 'generated', 'pool']).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Sample packs',
      content: { 'application/json': { schema: z.object({ items: z.array(PackRow) }) } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
  },
});

adminPacksRoutes.openapi(listPacksRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { genreSlug, kind } = c.req.valid('query');
  const d = db();

  const rows = await d.execute<{
    id: string;
    genre_id: string;
    genre_slug: string;
    genre_name: string;
    kind: 'uploaded' | 'generated' | 'pool';
    name: string;
    stem_count: number;
    created_at: string;
    created_by_handle: string | null;
  }>(sql`
    SELECT
      sp.id,
      sp.genre_id,
      g.slug AS genre_slug,
      g.name AS genre_name,
      sp.kind,
      sp.name,
      jsonb_array_length(sp.samples) AS stem_count,
      sp.created_at,
      u.handle AS created_by_handle
    FROM sample_packs sp
    JOIN genres g ON g.id = sp.genre_id
    LEFT JOIN users u ON u.id = sp.created_by
    WHERE (${genreSlug ?? null}::text IS NULL OR g.slug = ${genreSlug ?? null})
      AND (${kind ?? null}::sample_pack_kind IS NULL OR sp.kind = ${kind ?? null}::sample_pack_kind)
    ORDER BY sp.created_at DESC
  `);

  return c.json(
    {
      items: rows.map((r) => ({
        id: r.id,
        genreId: r.genre_id,
        genreSlug: r.genre_slug,
        genreName: r.genre_name,
        kind: r.kind,
        name: r.name,
        stemCount: Number(r.stem_count),
        createdAt: new Date(r.created_at).toISOString(),
        createdByHandle: r.created_by_handle ?? null,
      })),
    },
    200,
  );
});

// ─── POST /admin/sample-packs/:id/regenerate ────────────────────────────────

const regeneratePackRoute = createRoute({
  method: 'post',
  path: '/admin/sample-packs/{id}/regenerate',
  tags: ['admin', 'sample-packs'],
  summary: 'Delete S3 stems for this pack and re-fetch fresh ones from Freesound',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Regenerated pack',
      content: { 'application/json': { schema: PackRow } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
    404: { description: 'Not found', content: { 'application/json': { schema: AdminError } } },
    400: { description: 'Bad request', content: { 'application/json': { schema: AdminError } } },
  },
});

adminPacksRoutes.openapi(regeneratePackRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { id } = c.req.valid('param');
  const d = db();

  const [pack] = await d
    .select({
      id: samplePacks.id,
      genreId: samplePacks.genreId,
      kind: samplePacks.kind,
      name: samplePacks.name,
      samples: samplePacks.samples,
    })
    .from(samplePacks)
    .where(eq(samplePacks.id, id))
    .limit(1);

  if (!pack) return c.json({ error: 'not_found', message: 'Pack not found.' }, 404);

  const [genre] = await d
    .select({ id: genres.id, slug: genres.slug, name: genres.name, stemTypes: genres.stemTypes })
    .from(genres)
    .where(eq(genres.id, pack.genreId))
    .limit(1);

  if (!genre) return c.json({ error: 'genre_not_found', message: 'Genre not found.' }, 404);

  // Determine stem types: prefer genre.stemTypes, fall back to GENRE_STEMS map.
  const stemTypes: readonly string[] =
    (genre.stemTypes && genre.stemTypes.length > 0 ? genre.stemTypes : null) ??
    GENRE_STEMS[genre.slug] ??
    [];

  if (stemTypes.length === 0) {
    return c.json(
      {
        error: 'no_stem_types',
        message: 'Genre has no stemTypes configured and is not in GENRE_STEMS.',
      },
      400,
    );
  }

  // Delete existing S3 objects for this pack's stems (best-effort).
  const existingSamples = pack.samples as SamplePackItem[];
  for (const sample of existingSamples) {
    const key = keyFromUrl(sample.url);
    if (key) {
      try {
        await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
      } catch (err) {
        console.warn(`[regen] failed to delete S3 object ${key}:`, (err as Error).message);
      }
    }
  }

  // Fetch fresh stems.
  const items = await generatePackItems(genre.slug, stemTypes);

  // Update the pack row in place (same id).
  const [updated] = await d
    .update(samplePacks)
    .set({ samples: items as SamplePackItem[], createdBy: g.userId })
    .where(eq(samplePacks.id, id))
    .returning({
      id: samplePacks.id,
      genreId: samplePacks.genreId,
      kind: samplePacks.kind,
      name: samplePacks.name,
      samples: samplePacks.samples,
      createdAt: samplePacks.createdAt,
    });

  if (!updated) return c.json({ error: 'update_failed', message: 'Could not update pack.' }, 404);

  return c.json(
    {
      id: updated.id,
      genreId: updated.genreId,
      genreSlug: genre.slug,
      genreName: genre.name,
      kind: updated.kind,
      name: updated.name,
      stemCount: (updated.samples as SamplePackItem[]).length,
      createdAt: updated.createdAt.toISOString(),
      createdByHandle: null,
    },
    200,
  );
});

// ─── POST /admin/genres/:id/generate-pool-pack ──────────────────────────────

const generatePoolPackRoute = createRoute({
  method: 'post',
  path: '/admin/genres/{id}/generate-pool-pack',
  tags: ['admin', 'sample-packs'],
  summary: 'Generate a new pool pack for a genre from Freesound',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    201: {
      description: 'Created pack',
      content: { 'application/json': { schema: PackRow } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
    404: { description: 'Not found', content: { 'application/json': { schema: AdminError } } },
    400: { description: 'Bad request', content: { 'application/json': { schema: AdminError } } },
  },
});

adminPacksRoutes.openapi(generatePoolPackRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { id } = c.req.valid('param');
  const d = db();

  const [genre] = await d
    .select({ id: genres.id, slug: genres.slug, name: genres.name, stemTypes: genres.stemTypes })
    .from(genres)
    .where(eq(genres.id, id))
    .limit(1);

  if (!genre) return c.json({ error: 'not_found', message: 'Genre not found.' }, 404);

  const stemTypes: readonly string[] =
    (genre.stemTypes && genre.stemTypes.length > 0 ? genre.stemTypes : null) ??
    GENRE_STEMS[genre.slug] ??
    [];

  if (stemTypes.length === 0) {
    return c.json(
      {
        error: 'no_stem_types',
        message: 'Genre has no stemTypes configured and is not in GENRE_STEMS.',
      },
      400,
    );
  }

  // Count existing pool packs to name this one sequentially.
  const [countRow] = await d
    .select({ n: count() })
    .from(samplePacks)
    .where(and(eq(samplePacks.genreId, id), eq(samplePacks.kind, 'pool')));

  const packNumber = (countRow?.n ?? 0) + 1;
  const packName = `${genre.slug}-pool-${packNumber}`;

  const items = await generatePackItems(genre.slug, stemTypes);

  const [row] = await d
    .insert(samplePacks)
    .values({
      genreId: id,
      kind: 'pool',
      name: packName,
      createdBy: g.userId,
      samples: items as SamplePackItem[],
    })
    .returning({
      id: samplePacks.id,
      genreId: samplePacks.genreId,
      kind: samplePacks.kind,
      name: samplePacks.name,
      samples: samplePacks.samples,
      createdAt: samplePacks.createdAt,
    });

  if (!row) return c.json({ error: 'create_failed', message: 'Could not create pack.' }, 404);

  return c.json(
    {
      id: row.id,
      genreId: row.genreId,
      genreSlug: genre.slug,
      genreName: genre.name,
      kind: row.kind,
      name: row.name,
      stemCount: (row.samples as SamplePackItem[]).length,
      createdAt: row.createdAt.toISOString(),
      createdByHandle: null,
    },
    201,
  );
});

// ─── DELETE /admin/sample-packs/:id ─────────────────────────────────────────

const deletePackRoute = createRoute({
  method: 'delete',
  path: '/admin/sample-packs/{id}',
  tags: ['admin', 'sample-packs'],
  summary: 'Delete a sample pack row. S3 objects are left for audit.',
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

adminPacksRoutes.openapi(deletePackRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { id } = c.req.valid('param');
  const [row] = await db()
    .delete(samplePacks)
    .where(eq(samplePacks.id, id))
    .returning({ id: samplePacks.id });
  if (!row) return c.json({ error: 'not_found', message: 'Pack not found.' }, 404);
  return c.body(null, 204);
});

// Keep imports anchored.
void randomUUID;
void desc;
void ListObjectsV2Command;
