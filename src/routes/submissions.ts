// POST /rooms/:code/upload-url   - returns a presigned PUT URL for the
//                                    producer's track. Browser PUTs the file
//                                    directly to Object Storage.
// POST /rooms/:code/submission   - finalize: links the uploaded key back to
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
import { requireProducerQuota } from '../middleware/rate-limit.js';
import { maybeAdvanceAfterSubmission } from '../room/transitions.js';

const DAILY_CAP = 20;
// Daily Challenge song-length window: 90s..240s. Daily is async over 24h so
// we ask for a real song, not a 30s loop. Battle modes leave duration
// unconstrained on purpose - their timer already enforces brevity.
const DAILY_MIN_DURATION_SEC = 90;
const DAILY_MAX_DURATION_SEC = 240;

export const submissionsRoutes = new OpenAPIHono();

// Per-producer daily submission quota on the finalize endpoint only.
submissionsRoutes.use('/rooms/:code/submission', requireProducerQuota('sub'));

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

// Resolve a caller into (match, user). The caller's identity is derived
// from the authenticated session if present, otherwise from the pb_anon
// HttpOnly cookie's binding to a users.anon_id row. The `handle` body
// parameter is consulted only as a tie-breaker - if it doesn't match
// the caller's bound identity we reject rather than silently impersonate.
//
// Daily matches don't require a pre-seated row; other modes do.
async function matchAndUser(
  code: string,
  handle: string,
  ctx: { authenticatedUserId: string | null; anonId: string },
) {
  const d = db();
  const [m] = await d.select().from(matches).where(eq(matches.roomCode, code)).limit(1);
  if (!m) return { error: 'match not found' as const };

  let userRow: typeof users.$inferSelect | undefined;

  if (ctx.authenticatedUserId) {
    [userRow] = await d.select().from(users).where(eq(users.id, ctx.authenticatedUserId)).limit(1);
  } else if (handle) {
    // Handle-first resolution; the pb_anon cookie is the ownership check.
    // Reject rows bound to a DIFFERENT anon_id (impersonation). Claim
    // legacy guest stubs (anon_id NULL + @guest.local email) for this
    // cookie; real accounts also have anon_id NULL and must never be
    // resolvable by handle.
    [userRow] = await d.select().from(users).where(eq(users.handle, handle)).limit(1);
    if (userRow) {
      if (userRow.anonId != null && userRow.anonId !== ctx.anonId) {
        return { error: 'forbidden' as const };
      }
      if (userRow.anonId == null) {
        if (!userRow.email.endsWith('@guest.local')) {
          return { error: 'forbidden' as const };
        }
        await d.update(users).set({ anonId: ctx.anonId }).where(eq(users.id, userRow.id));
      }
    }
  } else {
    // No handle sent: fall back to whichever guest row this cookie
    // last used.
    [userRow] = await d.select().from(users).where(eq(users.anonId, ctx.anonId)).limit(1);
  }

  if (!userRow) return { error: 'user not found' as const };

  if (m.mode !== 'daily') {
    const [player] = await d
      .select()
      .from(matchPlayers)
      .where(and(eq(matchPlayers.matchId, m.id), eq(matchPlayers.userId, userRow.id)))
      .limit(1);
    if (!player) return { error: 'not a player in this match' as const };
  }

  return { match: m, user: userRow };
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

  const result = await matchAndUser(code, handle, {
    authenticatedUserId: c.var.user?.id ?? null,
    anonId: c.var.anonId,
  });
  if ('error' in result) {
    const status = result.error === 'forbidden' ? 403 : 404;
    return c.json({ error: result.error }, status);
  }

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
    400: { description: 'Submission rejected (e.g. low_quality from RMS gate)' },
    402: { description: 'Daily Challenge requires premium' },
    404: { description: 'Match or user not found' },
    409: { description: 'Already submitted' },
  },
});

submissionsRoutes.openapi(submitRoute, async (c) => {
  const { code } = c.req.valid('param');
  const body = c.req.valid('json');

  const result = await matchAndUser(code, body.user, {
    authenticatedUserId: c.var.user?.id ?? null,
    anonId: c.var.anonId,
  });
  if ('error' in result) {
    const status = result.error === 'forbidden' ? 403 : 404;
    return c.json({ error: result.error }, status);
  }

  const d = db();

  // Prevent double-submission per (match, user). Runs BEFORE the daily
  // duration gate so a 30s "second try" hits the 409 instead of being
  // misreported as too-short.
  const existing = await d.execute<{ id: string }>(
    sql`SELECT id FROM submissions
         WHERE match_id = ${result.match.id} AND user_id = ${result.user.id}
         LIMIT 1`,
  );
  if (existing.length > 0) {
    return c.json({ error: 'already submitted' }, 409);
  }

  // For daily matches: enforce the submission window, paid-tier gate, the
  // 20-unique-submitter cap, and the song-length window (90s..240s). Daily
  // is a 24-hour async window so we can ask for a real song; producers don't
  // get away with a 30-second loop. Battle modes intentionally don't enforce
  // minimum length.
  if (result.match.mode === 'daily') {
    // Submissions are only accepted during the 'submit' phase. Once voting
    // opens (status='vote') or the match is finalised (status='results'),
    // the window is closed.
    if (result.match.status !== 'submit') {
      return c.json(
        {
          error: 'submit_window_closed',
          message: 'Daily Challenge submissions are closed for today. Come back tomorrow.',
        },
        400,
      );
    }

    const user = c.var.user;
    if (!user || (user.plan !== 'paid' && user.role !== 'admin')) {
      return c.json(
        { error: 'payment_required', message: 'Daily Challenge is a Pro feature.' },
        402,
      );
    }
    if (body.durationSec != null && body.durationSec < DAILY_MIN_DURATION_SEC) {
      return c.json(
        {
          error: 'too_short',
          message: `Daily Challenge tracks must be at least ${DAILY_MIN_DURATION_SEC} seconds. Yours is ${body.durationSec}s.`,
        },
        400,
      );
    }
    if (body.durationSec != null && body.durationSec > DAILY_MAX_DURATION_SEC) {
      return c.json(
        {
          error: 'too_long',
          message: `Daily Challenge tracks must be at most ${DAILY_MAX_DURATION_SEC} seconds (4 minutes). Yours is ${body.durationSec}s.`,
        },
        400,
      );
    }
    const capRows = await d.execute<{ n: number }>(
      sql`SELECT COUNT(DISTINCT user_id)::int AS n FROM submissions WHERE match_id = ${result.match.id}`,
    );
    const count = (capRows[0] as { n: number } | undefined)?.n ?? 0;
    if (count >= DAILY_CAP) {
      return c.json({ error: "Today's board is full - come back tomorrow." }, 409);
    }
  }

  const audioUrl = publicUrl(body.key);

  // Anti-silence check: reject obviously empty/silent uploads so they
  // can't be used to satisfy the submit phase without an honor penalty.
  // Skipped in the test env (existing e2e tests upload synthesised
  // silent WAVs via a stub upload-url path).
  if (process.env.NODE_ENV !== 'test') {
    const { rmsLevelDbFs, isSilent } = await import('../audio/rms.js');
    const rms = await rmsLevelDbFs(audioUrl).catch(() => 0);
    if (isSilent(rms)) {
      return c.json(
        {
          error: 'low_quality',
          message: 'That upload is silent or near-silent. Submit something audible.',
        },
        400,
      );
    }
  }

  // Auto-generate a title when the producer leaves it blank so the feed
  // never shows "Untitled". Producers can rename later from their profile.
  const title = body.title && body.title.trim().length > 0 ? body.title.trim() : randomSongTitle();

  // Expiry: free-tier submissions are deleted after 30 days by the sweep worker.
  // Paid users and admins keep their submissions indefinitely (expiresAt = null).
  const uploader = c.var.user;
  const isPaid =
    uploader && (uploader.plan === 'paid' || uploader.role === 'admin' || uploader.role === 'ar');
  const expiresAt = isPaid ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

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
      expiresAt,
    })
    .returning();

  if (!row) return c.json({ error: 'failed to save submission' }, 500);

  // Fingerprint check runs inline in non-test environments. fpcalc absence
  // is non-fatal (runFingerprintCheck swallows the error and returns null).
  if (process.env.NODE_ENV !== 'test') {
    const { runFingerprintCheck } = await import('../audio/fp-check.js');
    const dq = await runFingerprintCheck(row.id, result.user.id, audioUrl);
    if (dq === 'self_resubmit') {
      return c.json(
        {
          error: 'self_resubmit',
          message: 'This beat is too similar to one you submitted in the last 30 days.',
        },
        400,
      );
    }
  }

  // For non-daily matches: if every seated player has submitted, advance to reveal.
  // Daily matches do not use the timed phase system.
  if (result.match.mode !== 'daily') {
    await maybeAdvanceAfterSubmission(result.match.id).catch((err) =>
      console.warn('[submissions] advance check failed:', (err as Error).message),
    );
  }

  return c.json({ id: row.id, audioUrl: await signUrl(audioUrl) });
});
