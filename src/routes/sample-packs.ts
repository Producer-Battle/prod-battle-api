// GET /matches/:code/sample-pack
// GET /matches/:code/sample-pack/zip
//
// Both look up the match's chosen pool pack (one per match - everyone in
// the room gets the same stems) and return either:
//   - the list of individual stem URLs (+ the ZIP url inline), or
//   - the pre-built ZIP URL direct from storage.
//
// Pool packs are seeded with a pre-built ZIP (sample_packs.zip_url), so we
// never rebuild on demand. Uploaded packs carry their own zip_url from the
// upload flow.

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { signUrl } from '../audio/s3.js';
import { buildPackZip } from '../audio/zip.js';
import { db } from '../db/client.js';
import { matches, samplePacks } from '../db/schema.js';

export const samplePacksRoutes = new OpenAPIHono();

const SamplePackItemSchema = z.object({
  stemType: z.string(),
  name: z.string(),
  url: z.string(),
});

const SamplePackResponse = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['uploaded', 'generated', 'pool']),
    name: z.string(),
    zipUrl: z.string().nullable(),
    samples: z.array(SamplePackItemSchema),
  })
  .openapi('SamplePackDetail');

const getPackRoute = createRoute({
  method: 'get',
  path: '/matches/{code}/sample-pack',
  tags: ['sample-packs'],
  summary: "Return a match's sample pack by room code",
  request: { params: z.object({ code: z.string() }) },
  responses: {
    200: {
      description: 'Sample pack',
      content: { 'application/json': { schema: SamplePackResponse } },
    },
    404: { description: 'Not found or match has no sample pack' },
  },
});

samplePacksRoutes.openapi(getPackRoute, async (c) => {
  const { code } = c.req.valid('param');
  const d = db();

  const [match] = await d
    .select({ sampleMode: matches.sampleMode, samplePackId: matches.samplePackId })
    .from(matches)
    .where(eq(matches.roomCode, code))
    .limit(1);
  if (!match) return c.json({ error: 'match not found' }, 404);
  if (match.sampleMode === 'none' || !match.samplePackId) {
    return c.json({ error: 'this match has no sample pack' }, 404);
  }

  const [pack] = await d
    .select()
    .from(samplePacks)
    .where(eq(samplePacks.id, match.samplePackId))
    .limit(1);
  if (!pack) return c.json({ error: 'sample pack not found' }, 404);

  // Re-sign URLs so the browser can fetch from the private bucket.
  const signedSamples = await Promise.all(
    pack.samples.map(async (s) => ({ ...s, url: await signUrl(s.url) })),
  );
  const signedZipUrl = pack.zipUrl ? await signUrl(pack.zipUrl) : null;

  return c.json({
    id: pack.id,
    kind: pack.kind,
    name: pack.name,
    zipUrl: signedZipUrl,
    samples: signedSamples,
  });
});

const zipRoute = createRoute({
  method: 'get',
  path: '/matches/{code}/sample-pack/zip',
  tags: ['sample-packs'],
  summary: 'Download URL for the match pack as a ZIP',
  request: {
    params: z.object({ code: z.string() }),
    query: z.object({
      // format=mp3 (default, free): lower-quality path (transcoding deferred - see ADR in handler).
      // format=wav (paid only): returns the pre-built WAV zip.
      format: z.enum(['mp3', 'wav']).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Download URL (pre-built for pool packs, built-on-demand otherwise)',
      content: {
        'application/json': {
          schema: z.object({
            url: z.string().url(),
            prebuilt: z.boolean(),
          }),
        },
      },
    },
    404: { description: 'No pack for this match' },
  },
});

samplePacksRoutes.openapi(zipRoute, async (c) => {
  const { code } = c.req.valid('param');
  const d = db();

  // Quality gate: ?format=wav requires a paid plan.
  //
  // ADR (deferred transcoding): the pack-zip files stored in S3 are already
  // WAV bundles. We gate access here so free users nominally get the 'mp3'
  // format path, but we do NOT yet transcode them - the actual zip returned
  // is the same WAV bundle for both paths. A future commit will add a
  // compressed-MP3 path (ffmpeg job via Scaleway Jobs) for the free tier.
  // Until that work lands, format=mp3 callers get WAV quality behind the
  // scenes, which is acceptable as a temporary over-delivery.
  const format = c.req.query('format') ?? 'mp3';
  if (format === 'wav') {
    const user = c.var.user;
    if (!user || (user.plan !== 'paid' && user.role !== 'admin')) {
      return c.json({ error: 'paid_feature', message: 'WAV downloads are a Pro feature.' }, 402);
    }
  }

  const [row] = await d
    .select({ matchId: matches.id, pack: samplePacks })
    .from(matches)
    .innerJoin(samplePacks, eq(samplePacks.id, matches.samplePackId))
    .where(eq(matches.roomCode, code))
    .limit(1);
  if (!row) return c.json({ error: 'no pack' }, 404);

  // Fast path: pool (and any uploaded) packs carry a pre-built ZIP URL.
  if (row.pack.zipUrl) {
    return c.json({ url: await signUrl(row.pack.zipUrl), prebuilt: true });
  }

  // Fallback: synthesize a ZIP from individual stems (legacy 'generated'
  // packs, or packs whose zip-building failed at seed time).
  try {
    const { url } = await buildPackZip(row.matchId, row.pack.samples);
    return c.json({ url, prebuilt: false });
  } catch (err) {
    console.error('[sample-packs] zip build failed:', (err as Error).message);
    return c.json({ error: 'could not build zip' }, 500);
  }
});
