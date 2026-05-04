// Tournament showcase phase endpoints.
//
// Between registration closing and round 1 opening, all entrants upload one
// showcase track. Any active signed-in user can listen and score (1-5) over
// the showcase window. Scores are visible live.
//
// Routes:
//   POST /tournaments/{id}/showcase/upload-url  - get presigned PUT URL
//   POST /tournaments/{id}/showcase/submission  - finalize upload
//   GET  /tournaments/{id}/showcase             - list + scores (auth required)
//   POST /tournaments/{id}/showcase/vote        - batch vote

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { bucket, publicUrl, s3, signUrl } from '../audio/s3.js';
import { db } from '../db/client.js';
import {
  tournamentEntries,
  tournamentShowcaseSubmissions,
  tournamentShowcaseVotes,
  tournaments,
  users,
} from '../db/schema.js';
import { getCategory } from '../game-rules/loader.js';
import { computeVoteWeight } from '../voting/weight.js';

export const tournamentShowcaseRoutes = new OpenAPIHono();

const SHOWCASE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const SHOWCASE_ALLOWED_TYPES = [
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/aac',
] as const;

function extFromShowcaseContentType(ct: string): string {
  if (ct === 'audio/mpeg') return 'mp3';
  if (ct === 'audio/mp4') return 'm4a';
  if (ct === 'audio/aac') return 'aac';
  return 'wav';
}

// ─── POST /tournaments/{id}/showcase/upload-url ────────────────────────────

const uploadUrlBody = z.object({
  contentType: z.enum(SHOWCASE_ALLOWED_TYPES).default('audio/mpeg'),
});

const uploadUrlRoute = createRoute({
  method: 'post',
  path: '/tournaments/{id}/showcase/upload-url',
  tags: ['tournament-showcase'],
  summary: 'Get a presigned PUT URL for a showcase track upload',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: uploadUrlBody } } },
  },
  responses: {
    200: {
      description: 'Presigned upload URL',
      content: {
        'application/json': {
          schema: z.object({
            url: z.string(),
            key: z.string(),
            maxBytes: z.number().int(),
            contentType: z.string(),
          }),
        },
      },
    },
    400: { description: 'Validation or phase error' },
    401: { description: 'Unauthenticated' },
    403: { description: 'Not an entrant or wrong phase' },
    404: { description: 'Tournament not found' },
    415: { description: 'Unsupported content type' },
  },
});

tournamentShowcaseRoutes.openapi(uploadUrlRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);

  const { id } = c.req.valid('param');
  const { contentType } = c.req.valid('json');

  if (!(SHOWCASE_ALLOWED_TYPES as readonly string[]).includes(contentType)) {
    return c.json({ error: 'unsupported_media_type', message: 'Unsupported audio type.' }, 415);
  }

  const d = db();
  const [t] = await d
    .select({ status: tournaments.status })
    .from(tournaments)
    .where(eq(tournaments.id, id))
    .limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Tournament not found.' }, 404);
  if (t.status !== 'showcase')
    return c.json({ error: 'wrong_phase', message: 'Showcase phase is not active.' }, 400);

  // Must be a registered entrant.
  const [entry] = await d
    .select({ tournamentId: tournamentEntries.tournamentId })
    .from(tournamentEntries)
    .where(
      sql`${tournamentEntries.tournamentId} = ${id} AND ${tournamentEntries.userId} = ${user.id}`,
    )
    .limit(1);
  if (!entry)
    return c.json(
      { error: 'not_entrant', message: 'You are not registered for this tournament.' },
      403,
    );

  const ext = extFromShowcaseContentType(contentType);
  const key = `showcase/${id}/${user.id}.${ext}`;
  const uploadUrl = await getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    { expiresIn: 10 * 60 },
  );

  return c.json({ url: uploadUrl, key, maxBytes: SHOWCASE_UPLOAD_MAX_BYTES, contentType });
});

// ─── POST /tournaments/{id}/showcase/submission ────────────────────────────

const submissionBody = z.object({
  key: z.string().min(1),
  title: z.string().max(120).optional(),
  durationSec: z.number().int().positive().max(7200).optional(),
});

const submissionRoute = createRoute({
  method: 'post',
  path: '/tournaments/{id}/showcase/submission',
  tags: ['tournament-showcase'],
  summary: 'Finalize a showcase track upload (upsert - re-upload overwrites)',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: submissionBody } } },
  },
  responses: {
    200: {
      description: 'Submission accepted',
      content: {
        'application/json': {
          schema: z.object({ id: z.string().uuid() }),
        },
      },
    },
    400: { description: 'Phase or timing error' },
    401: { description: 'Unauthenticated' },
    403: { description: 'Not an entrant' },
    404: { description: 'Tournament not found' },
  },
});

tournamentShowcaseRoutes.openapi(submissionRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);

  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const d = db();

  const [t] = await d
    .select({ status: tournaments.status, showcaseEndsAt: tournaments.showcaseEndsAt })
    .from(tournaments)
    .where(eq(tournaments.id, id))
    .limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Tournament not found.' }, 404);
  if (t.status !== 'showcase')
    return c.json({ error: 'wrong_phase', message: 'Showcase phase is not active.' }, 400);
  if (t.showcaseEndsAt && new Date(t.showcaseEndsAt) < new Date())
    return c.json({ error: 'window_closed', message: 'Showcase upload window has closed.' }, 400);

  // Must be a registered entrant.
  const [entry] = await d
    .select({ tournamentId: tournamentEntries.tournamentId })
    .from(tournamentEntries)
    .where(
      sql`${tournamentEntries.tournamentId} = ${id} AND ${tournamentEntries.userId} = ${user.id}`,
    )
    .limit(1);
  if (!entry)
    return c.json(
      { error: 'not_entrant', message: 'You are not registered for this tournament.' },
      403,
    );

  const audioUrl = publicUrl(body.key);

  // Upsert - re-upload overwrites the existing row.
  const [row] = (await d.execute<{ id: string }>(
    sql`INSERT INTO tournament_showcase_submissions
          (tournament_id, user_id, audio_url, title, duration_sec)
        VALUES
          (${id}, ${user.id}, ${audioUrl}, ${body.title ?? null}, ${body.durationSec ?? null})
        ON CONFLICT (tournament_id, user_id)
        DO UPDATE SET
          audio_url = EXCLUDED.audio_url,
          title = EXCLUDED.title,
          duration_sec = EXCLUDED.duration_sec,
          updated_at = now()
        RETURNING id`,
  )) as Array<{ id: string }>;

  if (!row) return c.json({ error: 'insert_failed', message: 'Could not save submission.' }, 400);
  return c.json({ id: row.id });
});

// ─── GET /tournaments/{id}/showcase ────────────────────────────────────────

const showcaseListRoute = createRoute({
  method: 'get',
  path: '/tournaments/{id}/showcase',
  tags: ['tournament-showcase'],
  summary: 'List showcase submissions with live scores (auth required)',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Showcase page data',
      content: {
        'application/json': {
          schema: z.object({
            status: z.string(),
            endsAt: z.string().nullable(),
            submissions: z.array(
              z.object({
                id: z.string().uuid(),
                label: z.string(),
                handle: z.string().nullable(),
                audioUrl: z.string(),
                durationSec: z.number().int().nullable(),
                score: z.number(),
                finalRank: z.number().int().nullable(),
                isOwn: z.boolean(),
                myScore: z.number().nullable(),
              }),
            ),
            canVote: z.boolean(),
          }),
        },
      },
    },
    401: { description: 'Unauthenticated - sign in to view the showcase' },
    404: { description: 'Tournament not found' },
  },
});

tournamentShowcaseRoutes.openapi(showcaseListRoute, async (c) => {
  const user = c.var.user;
  if (!user)
    return c.json({ error: 'unauthenticated', message: 'Sign in to view the showcase.' }, 401);

  const { id } = c.req.valid('param');
  const d = db();

  const [t] = await d
    .select({
      status: tournaments.status,
      showcaseEndsAt: tournaments.showcaseEndsAt,
    })
    .from(tournaments)
    .where(eq(tournaments.id, id))
    .limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Tournament not found.' }, 404);

  // Reveal real handles only after showcase has closed (status != 'showcase').
  const revealIdentities = t.status !== 'showcase';

  const now = new Date();
  const windowOpen =
    t.status === 'showcase' && t.showcaseEndsAt !== null && new Date(t.showcaseEndsAt) > now;

  // Submissions ordered by created_at ASC for stable labels.
  type SubRow = {
    id: string;
    user_id: string;
    handle: string | null;
    audio_url: string;
    duration_sec: number | null;
    score: string;
    final_rank: number | null;
    my_score: string | null;
  };

  const rows = (await d.execute<SubRow>(
    sql`SELECT
          tss.id,
          tss.user_id,
          ${revealIdentities ? sql`u.handle` : sql`NULL::text`} AS handle,
          tss.audio_url,
          tss.duration_sec,
          tss.score::text AS score,
          tss.final_rank,
          (SELECT tsv.weight::text
             FROM tournament_showcase_votes tsv
            WHERE tsv.submission_id = tss.id
              AND tsv.voter_id = ${user.id}
            LIMIT 1) AS my_score
        FROM tournament_showcase_submissions tss
        JOIN users u ON u.id = tss.user_id
       WHERE tss.tournament_id = ${id}
       ORDER BY tss.created_at ASC`,
  )) as SubRow[];

  const submissionsOut = await Promise.all(
    rows.map(async (r, i) => ({
      id: r.id,
      label: `Entry ${String.fromCharCode(65 + i)}`,
      handle: r.handle,
      audioUrl: await signUrl(r.audio_url, 3600),
      durationSec: r.duration_sec,
      score: Number(r.score),
      finalRank: r.final_rank,
      isOwn: r.user_id === user.id,
      myScore: r.my_score !== null ? Number(r.my_score) : null,
    })),
  );

  return c.json({
    status: t.status,
    endsAt: t.showcaseEndsAt ? new Date(t.showcaseEndsAt).toISOString() : null,
    submissions: submissionsOut,
    canVote: windowOpen,
  });
});

// ─── POST /tournaments/{id}/showcase/vote ─────────────────────────────────

const voteBody = z.object({
  votes: z
    .array(
      z.object({
        submissionId: z.string().uuid(),
        score: z.number().int().min(1).max(5),
      }),
    )
    .min(1)
    .max(32),
});

const showcaseVoteRoute = createRoute({
  method: 'post',
  path: '/tournaments/{id}/showcase/vote',
  tags: ['tournament-showcase'],
  summary: 'Cast showcase votes (batch)',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: voteBody } } },
  },
  responses: {
    200: {
      description: 'Votes recorded',
      content: {
        'application/json': {
          schema: z.object({
            accepted: z.number().int(),
            zeroWeighted: z.number().int(),
            droppedSelf: z.number().int(),
          }),
        },
      },
    },
    400: { description: 'Phase or window error' },
    401: { description: 'Unauthenticated' },
    404: { description: 'Tournament not found' },
  },
});

tournamentShowcaseRoutes.openapi(showcaseVoteRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);

  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const d = db();

  const [t] = await d
    .select({
      status: tournaments.status,
      showcaseEndsAt: tournaments.showcaseEndsAt,
    })
    .from(tournaments)
    .where(eq(tournaments.id, id))
    .limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Tournament not found.' }, 404);
  if (t.status !== 'showcase')
    return c.json({ error: 'wrong_phase', message: 'Showcase phase is not active.' }, 400);
  if (t.showcaseEndsAt && new Date(t.showcaseEndsAt) < new Date())
    return c.json({ error: 'window_closed', message: 'Showcase voting window has closed.' }, 400);

  // Load voter's honor for weight calculation.
  const [voterRow] = await d
    .select({ honor: users.honor, plan: users.plan })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (!voterRow) return c.json({ error: 'user_not_found', message: 'Voter not found.' }, 401);

  const votingRules = await getCategory('voting');

  // Load all showcase submissions for this tournament to enforce self-vote drop.
  const allSubs = (await d.execute<{ id: string; user_id: string }>(
    sql`SELECT id, user_id FROM tournament_showcase_submissions WHERE tournament_id = ${id}`,
  )) as Array<{ id: string; user_id: string }>;
  const subById = new Map(allSubs.map((s) => [s.id, s]));
  const ownSubmissionIds = new Set(allSubs.filter((s) => s.user_id === user.id).map((s) => s.id));

  const isPremium = voterRow.plan === 'paid';
  const weightFor = (rawScore: number): number =>
    computeVoteWeight({ rawScore, honor: voterRow.honor, isPremium, rules: votingRules });

  let accepted = 0;
  let zeroWeighted = 0;
  let droppedSelf = 0;

  for (const v of body.votes) {
    const sub = subById.get(v.submissionId);
    if (!sub) continue; // submission not in this tournament - ignore
    if (ownSubmissionIds.has(v.submissionId)) {
      // Self-vote silently dropped.
      droppedSelf++;
      continue;
    }

    const weight = weightFor(v.score);

    // Upsert vote (submission_id, voter_id) unique constraint.
    await d.execute(
      sql`INSERT INTO tournament_showcase_votes (submission_id, voter_id, weight)
            VALUES (${v.submissionId}, ${user.id}, ${String(weight)})
          ON CONFLICT (submission_id, voter_id)
          DO UPDATE SET weight = EXCLUDED.weight`,
    );

    // Update submission score = SUM(weight) across all voters.
    await d.execute(
      sql`UPDATE tournament_showcase_submissions
             SET score = COALESCE(
               (SELECT SUM(tsv.weight)
                  FROM tournament_showcase_votes tsv
                 WHERE tsv.submission_id = ${v.submissionId}),
               0
             )
           WHERE id = ${v.submissionId}`,
    );

    if (weight === 0) {
      zeroWeighted++;
    } else {
      accepted++;
    }
  }

  return c.json({ accepted, zeroWeighted, droppedSelf });
});

// Keep unused imports alive to satisfy the TypeScript checker.
void tournamentShowcaseSubmissions;
void tournamentShowcaseVotes;
