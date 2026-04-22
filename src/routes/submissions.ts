// POST /rooms/:code/upload-url   — returns a presigned PUT URL for the
//                                    producer's track. Browser PUTs the file
//                                    directly to Object Storage.
// POST /rooms/:code/submission   — finalize: links the uploaded key back to
//                                    the match + inserts a submissions row.
//
// Guest mode: the producer identifies via `{ user: handle }` in the body.
// Once auth lands this is replaced by the session user.

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { bucket, publicUrl, s3, signUrl } from '../audio/s3.js';
import { randomSongTitle } from '../audio/title.js';
import { db } from '../db/client.js';
import { matchPlayers, matches, submissions, users } from '../db/schema.js';
import { maybeAdvanceAfterSubmission } from '../room/transitions.js';

export const submissionsRoutes = new OpenAPIHono();

const UPLOAD_MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const ALLOWED_CONTENT_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/ogg',
] as const;

function extFromContentType(ct: string): string {
  if (ct === 'audio/mpeg' || ct === 'audio/mp3') return 'mp3';
  if (ct === 'audio/ogg') return 'ogg';
  return 'wav';
}

async function matchAndUser(code: string, handle: string) {
  const d = db();
  const [m] = await d.select().from(matches).where(eq(matches.roomCode, code)).limit(1);
  if (!m) return { error: 'match not found' as const };
  const [u] = await d.select().from(users).where(eq(users.handle, handle)).limit(1);
  if (!u) return { error: 'user not found' as const };
  const [player] = await d
    .select()
    .from(matchPlayers)
    .where(and(eq(matchPlayers.matchId, m.id), eq(matchPlayers.userId, u.id)))
    .limit(1);
  if (!player) return { error: 'not a player in this match' as const };
  return { match: m, user: u };
}

// ─── POST /rooms/:code/upload-url ────────────────────────────────────────

const uploadUrlBody = z.object({
  user: z.string().min(1),
  contentType: z.enum(ALLOWED_CONTENT_TYPES).default('audio/mpeg'),
});

const uploadUrlRoute = createRoute({
  method: 'post',
  path: '/rooms/{code}/upload-url',
  tags: ['submissions'],
  summary: 'Presigned PUT URL for the match submission',
  request: {
    params: z.object({ code: z.string() }),
    body: { content: { 'application/json': { schema: uploadUrlBody } } },
  },
  responses: {
    200: {
      description: 'Signed URL',
      content: {
        'application/json': {
          schema: z.object({
            url: z.string().url(),
            key: z.string(),
            maxBytes: z.number().int(),
            contentType: z.string(),
          }),
        },
      },
    },
    400: { description: 'Validation failed' },
    404: { description: 'Match not found' },
  },
});

submissionsRoutes.openapi(uploadUrlRoute, async (c) => {
  const { code } = c.req.valid('param');
  const { user: handle, contentType } = c.req.valid('json');

  const result = await matchAndUser(code, handle);
  if ('error' in result) return c.json({ error: result.error }, 404);

  const ext = extFromContentType(contentType);
  const key = `matches/${result.match.id}/${result.user.id}.${ext}`;

  const url = await getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: 10 * 60 }, // 10 min to complete upload
  );

  return c.json({ url, key, maxBytes: UPLOAD_MAX_BYTES, contentType });
});

// ─── POST /rooms/:code/submission ────────────────────────────────────────

const submitBody = z.object({
  user: z.string().min(1),
  key: z.string().min(1),
  title: z.string().max(120).optional(),
  description: z.string().max(400).optional(),
  durationSec: z.number().int().positive().max(7200).optional(),
});

const submitRoute = createRoute({
  method: 'post',
  path: '/rooms/{code}/submission',
  tags: ['submissions'],
  summary: 'Finalize a match submission after upload',
  request: {
    params: z.object({ code: z.string() }),
    body: { content: { 'application/json': { schema: submitBody } } },
  },
  responses: {
    200: {
      description: 'Submission accepted',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string().uuid(),
            audioUrl: z.string().url(),
          }),
        },
      },
    },
    404: { description: 'Match or user not found' },
    409: { description: 'Already submitted' },
  },
});

submissionsRoutes.openapi(submitRoute, async (c) => {
  const { code } = c.req.valid('param');
  const body = c.req.valid('json');

  const result = await matchAndUser(code, body.user);
  if ('error' in result) return c.json({ error: result.error }, 404);

  const d = db();

  // Prevent double-submission per (match, user).
  const existing = await d.execute<{ id: string }>(
    sql`SELECT id FROM submissions
         WHERE match_id = ${result.match.id} AND user_id = ${result.user.id}
         LIMIT 1`,
  );
  if (existing.length > 0) {
    return c.json({ error: 'already submitted' }, 409);
  }

  const audioUrl = publicUrl(body.key);
  // Auto-generate a title when the producer leaves it blank so the feed
  // never shows "Untitled". Producers can rename later from their profile.
  const title = body.title && body.title.trim().length > 0 ? body.title.trim() : randomSongTitle();
  const [row] = await d
    .insert(submissions)
    .values({
      matchId: result.match.id,
      userId: result.user.id,
      genreId: result.match.primaryGenreId,
      audioUrl,
      durationSec: body.durationSec ?? null,
      title,
      description: body.description ?? null,
      isPublic: true,
    })
    .returning();

  if (!row) return c.json({ error: 'failed to save submission' }, 500);

  // If every seated player has submitted, short-circuit the submit timer
  // and advance straight into reveal.
  await maybeAdvanceAfterSubmission(result.match.id).catch((err) =>
    console.warn('[submissions] advance check failed:', (err as Error).message),
  );

  return c.json({ id: row.id, audioUrl: await signUrl(audioUrl) });
});
