// A&R dashboard endpoints.
//
// Open to role in ('ar', 'admin'). Surfaces two things:
//   - top producers by recent voted performance
//   - a feed of recently-finished battles worth listening to
//
// Ranking math is deliberately simple for v1 (wins - losses weighted by
// matches played). Replace with Glicko once rankings.glickoRating is
// populated post-match.

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export const arRoutes = new OpenAPIHono();

const ArError = z.object({ error: z.string(), message: z.string() });

const requireAr = (
  c: Parameters<Parameters<typeof arRoutes.openapi>[1]>[0],
):
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; body: { error: string; message: string } } => {
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
};

// ─── GET /ar/producers ───────────────────────────────────────────────────────

const topProducersRoute = createRoute({
  method: 'get',
  path: '/ar/producers',
  tags: ['ar'],
  summary: 'Top producers by recent performance',
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      genreSlug: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Producers',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(
              z.object({
                userId: z.string().uuid(),
                handle: z.string(),
                avatarUrl: z.string().nullable(),
                matchesPlayed: z.number().int(),
                wins: z.number().int(),
                totalSubmissionScore: z.number(),
              }),
            ),
          }),
        },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ArError } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ArError } } },
  },
});

arRoutes.openapi(topProducersRoute, async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { limit, genreSlug } = c.req.valid('query');
  const d = db();

  // A "win" = finalRank === 1 on the submission. totalSubmissionScore sums
  // the numeric score each submission accumulated (votes × weight, already
  // rolled up by the match-results step).
  const rows = await d.execute<{
    user_id: string;
    handle: string;
    avatar_url: string | null;
    matches_played: string;
    wins: string;
    total_score: string;
  }>(sql`
    SELECT u.id AS user_id,
           u.handle,
           u.avatar_url,
           COUNT(DISTINCT s.match_id)::text          AS matches_played,
           COUNT(*) FILTER (WHERE s.final_rank = 1)::text AS wins,
           COALESCE(SUM(s.score), 0)::text           AS total_score
      FROM users u
      JOIN submissions s ON s.user_id = u.id
      JOIN genres g ON g.id = s.genre_id
     WHERE u.role IN ('producer')
       AND (${genreSlug ?? null}::text IS NULL OR g.slug = ${genreSlug ?? null})
     GROUP BY u.id, u.handle, u.avatar_url
     HAVING COUNT(DISTINCT s.match_id) > 0
     ORDER BY total_score DESC, wins DESC
     LIMIT ${limit}
  `);

  return c.json(
    {
      items: rows.map((r) => ({
        userId: r.user_id,
        handle: r.handle,
        avatarUrl: r.avatar_url,
        matchesPlayed: Number(r.matches_played),
        wins: Number(r.wins),
        totalSubmissionScore: Number(r.total_score),
      })),
    },
    200,
  );
});

// ─── GET /ar/battles/recent ─────────────────────────────────────────────────

const recentBattlesRoute = createRoute({
  method: 'get',
  path: '/ar/battles/recent',
  tags: ['ar'],
  summary: 'Recently-finished battles, newest first',
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      genreSlug: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Battles',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(
              z.object({
                matchId: z.string().uuid(),
                genreSlug: z.string(),
                genreName: z.string(),
                endedAt: z.string().datetime(),
                submissions: z.array(
                  z.object({
                    submissionId: z.string().uuid(),
                    userHandle: z.string(),
                    finalRank: z.number().int().nullable(),
                    score: z.number(),
                    audioUrl: z.string(),
                  }),
                ),
              }),
            ),
          }),
        },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ArError } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ArError } } },
  },
});

arRoutes.openapi(recentBattlesRoute, async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { limit, genreSlug } = c.req.valid('query');
  const d = db();

  type Row = {
    match_id: string;
    genre_slug: string;
    genre_name: string;
    ended_at: string;
    submission_id: string;
    user_handle: string;
    final_rank: number | null;
    score: string;
    audio_url: string;
  };
  const rows = await d.execute<Row>(sql`
    SELECT m.id AS match_id,
           g.slug AS genre_slug,
           g.name AS genre_name,
           m.ended_at,
           s.id AS submission_id,
           u.handle AS user_handle,
           s.final_rank,
           s.score::text AS score,
           s.audio_url
      FROM matches m
      JOIN genres g ON g.id = m.primary_genre_id
      JOIN submissions s ON s.match_id = m.id
      JOIN users u ON u.id = s.user_id
     WHERE m.status = 'results'
       AND m.ended_at IS NOT NULL
       AND (${genreSlug ?? null}::text IS NULL OR g.slug = ${genreSlug ?? null})
     ORDER BY m.ended_at DESC, s.final_rank ASC NULLS LAST
     LIMIT ${limit * 10}
  `);

  // Fold submissions under their match, preserving ended_at ordering.
  const byMatch = new Map<
    string,
    {
      matchId: string;
      genreSlug: string;
      genreName: string;
      endedAt: string;
      submissions: {
        submissionId: string;
        userHandle: string;
        finalRank: number | null;
        score: number;
        audioUrl: string;
      }[];
    }
  >();

  for (const r of rows) {
    let entry = byMatch.get(r.match_id);
    if (!entry) {
      entry = {
        matchId: r.match_id,
        genreSlug: r.genre_slug,
        genreName: r.genre_name,
        endedAt: new Date(r.ended_at).toISOString(),
        submissions: [],
      };
      byMatch.set(r.match_id, entry);
    }
    entry.submissions.push({
      submissionId: r.submission_id,
      userHandle: r.user_handle,
      finalRank: r.final_rank,
      score: Number(r.score),
      audioUrl: r.audio_url,
    });
  }

  const items = Array.from(byMatch.values()).slice(0, limit);
  return c.json({ items }, 200);
});
