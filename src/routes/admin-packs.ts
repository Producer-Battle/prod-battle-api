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
import { bucket, keyFromUrl, s3, signUrl } from '../audio/s3.js';
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
  summary: 'Kick off background regeneration of a pack from Freesound',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    202: {
      description: 'Accepted - samples cleared; background task refills and swaps them in',
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

// Same fire-and-forget shape as the generate route. Clearing samples to
// [] is the "generating" signal the UI polls on; stemCount flips back
// to N when the refill completes.
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

  // Snapshot the old samples list so we can delete their S3 objects in
  // the background. Clear samples immediately so the UI shows "generating"
  // state on the next poll.
  const existingSamples = pack.samples as SamplePackItem[];
  const [updated] = await d
    .update(samplePacks)
    .set({ samples: [] as SamplePackItem[], createdBy: g.userId })
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

  const packId = updated.id;
  const slug = genre.slug;
  void (async () => {
    for (const sample of existingSamples) {
      const key = keyFromUrl(sample.url);
      if (!key) continue;
      try {
        await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
      } catch (err) {
        console.warn(`[regen] failed to delete S3 object ${key}:`, (err as Error).message);
      }
    }
    try {
      const items = await generatePackItems(slug, stemTypes);
      await db()
        .update(samplePacks)
        .set({ samples: items as SamplePackItem[] })
        .where(eq(samplePacks.id, packId));
      console.log(`[admin-packs] pack ${updated.name} regenerated (${items.length} stems)`);
    } catch (err) {
      console.error(`[admin-packs] pack ${updated.name} regeneration failed:`, err);
    }
  })();

  return c.json(
    {
      id: updated.id,
      genreId: updated.genreId,
      genreSlug: genre.slug,
      genreName: genre.name,
      kind: updated.kind,
      name: updated.name,
      stemCount: 0,
      createdAt: updated.createdAt.toISOString(),
      createdByHandle: null,
    },
    202,
  );
});

// ─── POST /admin/genres/:id/generate-pool-pack ──────────────────────────────

const generatePoolPackRoute = createRoute({
  method: 'post',
  path: '/admin/genres/{id}/generate-pool-pack',
  tags: ['admin', 'sample-packs'],
  summary: 'Kick off background pool-pack generation for a genre',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    202: {
      description: 'Accepted - pack row created with empty samples; background task fills it in',
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

// Generation is synchronous inside the container (Freesound + ffmpeg +
// S3 upload per stem) and can take ~30s for a full genre. Holding the
// HTTP request open that long makes the admin UI feel frozen, so we
// return 202 with a placeholder pack row (samples=[]) and finish the
// work in the background. The client polls GET /admin/sample-packs and
// sees stemCount go from 0 to N when the pack is ready.
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

  const [countRow] = await d
    .select({ n: count() })
    .from(samplePacks)
    .where(and(eq(samplePacks.genreId, id), eq(samplePacks.kind, 'pool')));

  const packNumber = (countRow?.n ?? 0) + 1;
  const packName = `${genre.slug}-pool-${packNumber}`;

  const [row] = await d
    .insert(samplePacks)
    .values({
      genreId: id,
      kind: 'pool',
      name: packName,
      createdBy: g.userId,
      samples: [] as SamplePackItem[],
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

  // Fire-and-forget. Not awaited so the HTTP response goes out immediately.
  // If it fails, we log and leave the empty pack row as a clear signal in
  // the admin UI that a retry (regenerate) is needed.
  const packId = row.id;
  const slug = genre.slug;
  void (async () => {
    try {
      const items = await generatePackItems(slug, stemTypes);
      await db()
        .update(samplePacks)
        .set({ samples: items as SamplePackItem[] })
        .where(eq(samplePacks.id, packId));
      console.log(`[admin-packs] pool pack ${packName} ready (${items.length} stems)`);
    } catch (err) {
      console.error(`[admin-packs] pool pack ${packName} generation failed:`, err);
    }
  })();

  return c.json(
    {
      id: row.id,
      genreId: row.genreId,
      genreSlug: genre.slug,
      genreName: genre.name,
      kind: row.kind,
      name: row.name,
      stemCount: 0,
      createdAt: row.createdAt.toISOString(),
      createdByHandle: null,
    },
    202,
  );
});

// ─── POST /admin/sample-packs/:id/promote ───────────────────────────────────
// Flip a user-uploaded pack to kind='pool' so anyone can use it in matches.
// One-way for now (delete + re-upload to undo). The pack's createdBy is
// preserved as an audit attribution.

const promotePackRoute = createRoute({
  method: 'post',
  path: '/admin/sample-packs/{id}/promote',
  tags: ['admin', 'sample-packs'],
  summary: 'Promote a kind=uploaded pack to kind=pool (anyone can use).',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Promoted', content: { 'application/json': { schema: PackRow } } },
    400: { description: 'Already pool', content: { 'application/json': { schema: AdminError } } },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
    404: { description: 'Not found', content: { 'application/json': { schema: AdminError } } },
  },
});

adminPacksRoutes.openapi(promotePackRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { id } = c.req.valid('param');
  const d = db();

  const [existing] = await d
    .select({ id: samplePacks.id, kind: samplePacks.kind })
    .from(samplePacks)
    .where(eq(samplePacks.id, id))
    .limit(1);
  if (!existing) return c.json({ error: 'not_found', message: 'Pack not found.' }, 404);
  if (existing.kind === 'pool') {
    return c.json({ error: 'already_pool', message: 'Pack is already pool.' }, 400);
  }
  if (existing.kind !== 'uploaded') {
    return c.json(
      { error: 'wrong_kind', message: 'Only kind=uploaded packs can be promoted.' },
      400,
    );
  }

  await d.update(samplePacks).set({ kind: 'pool' }).where(eq(samplePacks.id, id));

  const [row] = await d.execute<{
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
    SELECT sp.id, sp.genre_id, g.slug AS genre_slug, g.name AS genre_name,
           sp.kind, sp.name, jsonb_array_length(sp.samples) AS stem_count,
           sp.created_at, u.handle AS created_by_handle
      FROM sample_packs sp
      JOIN genres g ON g.id = sp.genre_id
      LEFT JOIN users u ON u.id = sp.created_by
     WHERE sp.id = ${id}
  `);
  if (!row) return c.json({ error: 'not_found', message: 'Pack not found.' }, 404);

  return c.json(
    {
      id: row.id,
      genreId: row.genre_id,
      genreSlug: row.genre_slug,
      genreName: row.genre_name,
      kind: row.kind,
      name: row.name,
      stemCount: Number(row.stem_count),
      createdAt: new Date(row.created_at).toISOString(),
      createdByHandle: row.created_by_handle ?? null,
    },
    200,
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

// ─── GET /admin/sample-packs/:id/stems ──────────────────────────────────────

const StemRow = z.object({
  stemType: z.string(),
  name: z.string(),
  url: z.string(),
  durationSec: z.number().int().nullable(),
});

const listStemsRoute = createRoute({
  method: 'get',
  path: '/admin/sample-packs/{id}/stems',
  tags: ['admin', 'sample-packs'],
  summary: 'List stems for a pack with short-lived signed GET URLs',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Stems',
      content: {
        'application/json': { schema: z.object({ items: z.array(StemRow) }) },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
    404: { description: 'Not found', content: { 'application/json': { schema: AdminError } } },
  },
});

adminPacksRoutes.openapi(listStemsRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { id } = c.req.valid('param');
  const [pack] = await db()
    .select({ id: samplePacks.id, samples: samplePacks.samples })
    .from(samplePacks)
    .where(eq(samplePacks.id, id))
    .limit(1);

  if (!pack) return c.json({ error: 'not_found', message: 'Pack not found.' }, 404);

  const samples = pack.samples as SamplePackItem[];
  if (samples.length === 0) return c.json({ items: [] }, 200);

  const items = await Promise.all(
    samples.map(async (s) => ({
      stemType: s.stemType,
      name: s.name,
      url: await signUrl(s.url, 3600),
      durationSec: null as number | null,
    })),
  );

  return c.json({ items }, 200);
});

// Keep imports anchored.
void randomUUID;
void desc;
void ListObjectsV2Command;
