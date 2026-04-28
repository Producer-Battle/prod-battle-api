// User-uploaded sample packs.
//
// Two-step flow:
//   1. POST /user-packs/upload-url  → presigned PUT URLs for each stem file,
//                                      one per sample the user wants to upload
//   2. POST /user-packs             → finalize: create a sample_packs row with
//                                      the URLs the client just PUT to
//
// Uploads go directly browser → S3, bypassing the API. That keeps audio bytes
// off the Hono/Node event loop and avoids having to proxy multipart through
// the container.
//
// Requires role in (producer, ar, admin) - i.e. any authenticated user.
// Anonymous uploads are out of scope (no identity to attach the pack to).

import { randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, sql } from 'drizzle-orm';
import { bucket, publicUrl, s3 } from '../audio/s3.js';
import { db } from '../db/client.js';
import { type SamplePackItem, genres, samplePacks, users } from '../db/schema.js';
import { requireProducerQuota } from '../middleware/rate-limit.js';

export const userPacksRoutes = new OpenAPIHono();

// Per-producer daily pack-upload quota on the finalize endpoint only.
// The upload-url step is per-sample and not the meaningful gate.
userPacksRoutes.use('/user-packs', requireProducerQuota('pack'));

const ErrorBody = z.object({ error: z.string(), message: z.string() });

// Stem types we accept. Keep aligned with GENRE_STEMS in
// matchmaking/defaults.ts - clients shouldn't be able to sneak new types in.
const STEM_TYPES = [
  'kick',
  'snare',
  'hihat',
  'openhat',
  'clap',
  'perc',
  'fx',
  '808',
  'bass',
  'lead',
  'pad',
  'vocal',
  'zap',
  'screech',
  'reverse',
  'cowbell',
] as const;

const MAX_SAMPLES_PER_PACK = 32;
const PRESIGN_TTL_SEC = 600; // 10 min upload window

// Supporter perk #3: pack quota limits.
//   Free tier:  1 active uploaded pack
//   Paid tier: 10 active uploaded packs
// "Active" = kind='uploaded' AND deleted_at IS NULL (soft-delete pattern not
// yet implemented for packs so we just count all kind='uploaded' rows by creator).
const FREE_PACK_QUOTA = 1;
const PAID_PACK_QUOTA = 10;

/**
 * Check whether the user has reached their pack quota.
 * Returns { allowed: true } or { allowed: false, quota, current }.
 */
export async function checkPackQuota(
  userId: string,
  plan: 'free' | 'paid',
): Promise<{ allowed: boolean; quota: number; current: number }> {
  const quota = plan === 'paid' ? PAID_PACK_QUOTA : FREE_PACK_QUOTA;
  const d = db();
  const [row] = await d.execute<{ n: string }>(
    sql`SELECT COUNT(*)::text AS n FROM sample_packs
         WHERE created_by = ${userId} AND kind = 'uploaded'`,
  );
  const current = Number(row?.n ?? 0);
  return { allowed: current < quota, quota, current };
}

// ─── POST /user-packs/upload-url ────────────────────────────────────────────

const requestUploadRoute = createRoute({
  method: 'post',
  path: '/user-packs/upload-url',
  tags: ['user-packs'],
  summary: 'Request presigned upload URLs for a pack under construction',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            samples: z
              .array(
                z.object({
                  stemType: z.enum(STEM_TYPES),
                  // Original filename from the client - used only to pick an
                  // extension for the stored key, not to drive routing.
                  filename: z.string().min(1).max(128),
                  contentType: z.string().min(3).max(64),
                }),
              )
              .min(1)
              .max(MAX_SAMPLES_PER_PACK),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Presigned upload handles',
      content: {
        'application/json': {
          schema: z.object({
            // Pack id chosen by the server - the client passes this back on
            // POST /user-packs so we can link the uploaded URLs.
            packStagingId: z.string().uuid(),
            samples: z.array(
              z.object({
                stemType: z.enum(STEM_TYPES),
                uploadUrl: z.string().url(),
                publicUrl: z.string().url(),
                key: z.string(),
              }),
            ),
            expiresAt: z.string().datetime(),
          }),
        },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorBody } } },
  },
});

userPacksRoutes.openapi(requestUploadRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);

  const { samples } = c.req.valid('json');
  const packStagingId = randomUUID();
  const b = bucket();
  const client = s3();
  const expiresAt = new Date(Date.now() + PRESIGN_TTL_SEC * 1000);

  const handles = await Promise.all(
    samples.map(async (s) => {
      const ext = pickExt(s.filename, s.contentType);
      const fileId = randomUUID();
      // Storage layout: user-packs/<pack-staging-id>/<stem-type>-<uuid>.<ext>
      const key = `user-packs/${packStagingId}/${s.stemType}-${fileId}${ext}`;
      const uploadUrl = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: b, Key: key, ContentType: s.contentType }),
        { expiresIn: PRESIGN_TTL_SEC },
      );
      return {
        stemType: s.stemType,
        uploadUrl,
        publicUrl: publicUrl(key),
        key,
      };
    }),
  );

  return c.json(
    {
      packStagingId,
      samples: handles,
      expiresAt: expiresAt.toISOString(),
    },
    200,
  );
});

// ─── POST /user-packs (finalize) ────────────────────────────────────────────

const finalizeRoute = createRoute({
  method: 'post',
  path: '/user-packs',
  tags: ['user-packs'],
  summary: 'Finalize an uploaded pack - creates a sample_packs row',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            genreId: z.string().uuid(),
            name: z.string().min(2).max(64),
            // Uploader must confirm copyright clearance on every upload.
            // Stored as a timestamp on the inserted row for audit purposes.
            copyrightAttested: z.literal(true),
            samples: z
              .array(
                z.object({
                  stemType: z.enum(STEM_TYPES),
                  name: z.string().min(1).max(128),
                  url: z.string().url(),
                }),
              )
              .min(1)
              .max(MAX_SAMPLES_PER_PACK),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Created',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string().uuid(),
            genreId: z.string().uuid(),
            name: z.string(),
            sampleCount: z.number().int(),
          }),
        },
      },
    },
    400: { description: 'Invalid genre', content: { 'application/json': { schema: ErrorBody } } },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorBody } } },
  },
});

userPacksRoutes.openapi(finalizeRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);

  // Supporter perk #3: enforce per-tier pack quota before creating the row.
  const quotaCheck = await checkPackQuota(user.id, user.plan as 'free' | 'paid');
  if (!quotaCheck.allowed) {
    return c.json(
      {
        error: 'pack_quota',
        message: `You've reached your pack limit (${quotaCheck.quota}). Upgrade to Supporter to upload more packs.`,
      },
      402 as never,
    );
  }

  const body = c.req.valid('json');
  const d = db();

  // Genre must exist and be something the user can attach to - proposed user
  // genres they authored themselves OR any active genre.
  const [genre] = await d
    .select({ id: genres.id, status: genres.status, createdBy: genres.createdBy })
    .from(genres)
    .where(eq(genres.id, body.genreId))
    .limit(1);
  if (!genre) return c.json({ error: 'genre_not_found', message: 'No such genre.' }, 400);
  if (genre.status !== 'active' && genre.createdBy !== user.id) {
    return c.json(
      { error: 'genre_not_usable', message: 'Attach to an active genre or one you proposed.' },
      400,
    );
  }

  const [row] = await d
    .insert(samplePacks)
    .values({
      genreId: body.genreId,
      kind: 'uploaded',
      name: body.name,
      createdBy: user.id,
      samples: body.samples as SamplePackItem[],
      copyrightAttestedAt: new Date(),
    })
    .returning({ id: samplePacks.id, genreId: samplePacks.genreId, name: samplePacks.name });

  if (!row) {
    return c.json({ error: 'create_failed', message: 'Could not create pack.' }, 400);
  }

  return c.json(
    { id: row.id, genreId: row.genreId, name: row.name, sampleCount: body.samples.length },
    201,
  );
});

// ─── GET /user-packs/mine ────────────────────────────────────────────────────

const listMineRoute = createRoute({
  method: 'get',
  path: '/user-packs/mine',
  tags: ['user-packs'],
  summary: 'My uploaded sample packs',
  responses: {
    200: {
      description: 'Packs',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                genreId: z.string().uuid(),
                name: z.string(),
                sampleCount: z.number().int(),
                createdAt: z.string().datetime(),
              }),
            ),
          }),
        },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorBody } } },
  },
});

userPacksRoutes.openapi(listMineRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);

  const d = db();
  const rows = await d
    .select({
      id: samplePacks.id,
      genreId: samplePacks.genreId,
      name: samplePacks.name,
      samples: samplePacks.samples,
      createdAt: samplePacks.createdAt,
    })
    .from(samplePacks)
    .where(and(eq(samplePacks.createdBy, user.id), eq(samplePacks.kind, 'uploaded')))
    .orderBy(desc(samplePacks.createdAt));

  return c.json(
    {
      items: rows.map((r) => ({
        id: r.id,
        genreId: r.genreId,
        name: r.name,
        sampleCount: (r.samples ?? []).length,
        createdAt: new Date(r.createdAt).toISOString(),
      })),
    },
    200,
  );
});

// Small helper: pick a file extension from filename or content type.
function pickExt(filename: string, contentType: string): string {
  const fromName = filename.match(/\.([A-Za-z0-9]{1,6})$/);
  if (fromName?.[1]) return `.${fromName[1].toLowerCase()}`;
  if (contentType.includes('wav')) return '.wav';
  if (contentType.includes('ogg')) return '.ogg';
  if (contentType.includes('opus')) return '.opus';
  if (contentType.includes('mp3') || contentType.includes('mpeg')) return '.mp3';
  return '.bin';
}
