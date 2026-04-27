// Tournament read-only list endpoint. Tournaments today are one-off
// elimination matches with mode='tournament'; this endpoint surfaces
// the recent set so the web /tournaments page can render them.
//
// The full scheduling system (registration windows, bracket id linking
// multiple matches, prize plumbing) is roadmap. Today's view is a flat
// list with results when finished.

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export const tournamentsRoutes = new OpenAPIHono();

const TournamentRow = z.object({
  matchId: z.string().uuid(),
  roomCode: z.string(),
  status: z.string(),
  genreSlug: z.string(),
  genreName: z.string(),
  teamCount: z.number().int(),
  teamSize: z.number().int(),
  createdAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  winner: z
    .object({
      handle: z.string(),
      score: z.number(),
    })
    .nullable(),
});

const listRoute = createRoute({
  method: 'get',
  path: '/tournaments',
  tags: ['tournaments'],
  summary: 'Recent tournament matches (read-only)',
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(50).optional().default(20),
    }),
  },
  responses: {
    200: {
      description: 'Tournament matches',
      content: {
        'application/json': { schema: z.object({ items: z.array(TournamentRow) }) },
      },
    },
  },
});

tournamentsRoutes.openapi(listRoute, async (c) => {
  const { limit } = c.req.valid('query');
  const rows = await db().execute<{
    match_id: string;
    room_code: string;
    status: string;
    genre_slug: string;
    genre_name: string;
    team_count: number;
    team_size: number;
    created_at: Date | string;
    ended_at: Date | string | null;
    winner_handle: string | null;
    winner_score: string | null;
  }>(
    sql`SELECT m.id AS match_id,
               m.room_code,
               m.status,
               g.slug AS genre_slug,
               g.name AS genre_name,
               m.team_count,
               m.team_size,
               m.created_at,
               m.ended_at,
               winner.handle AS winner_handle,
               winner.score::text AS winner_score
          FROM matches m
          JOIN genres g ON g.id = m.primary_genre_id
          LEFT JOIN LATERAL (
            SELECT u.handle, s.score
              FROM submissions s
              JOIN users u ON u.id = s.user_id
             WHERE s.match_id = m.id AND s.final_rank = 1
             LIMIT 1
          ) AS winner ON true
         WHERE m.mode = 'tournament'
         ORDER BY m.created_at DESC
         LIMIT ${limit}`,
  );

  const arr = rows as Array<{
    match_id: string;
    room_code: string;
    status: string;
    genre_slug: string;
    genre_name: string;
    team_count: number;
    team_size: number;
    created_at: Date | string;
    ended_at: Date | string | null;
    winner_handle: string | null;
    winner_score: string | null;
  }>;
  return c.json(
    {
      items: arr.map((r) => ({
        matchId: r.match_id,
        roomCode: r.room_code,
        status: r.status,
        genreSlug: r.genre_slug,
        genreName: r.genre_name,
        teamCount: Number(r.team_count),
        teamSize: Number(r.team_size),
        createdAt: new Date(r.created_at).toISOString(),
        endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
        winner:
          r.winner_handle != null
            ? { handle: r.winner_handle, score: Number(r.winner_score ?? 0) }
            : null,
      })),
    },
    200,
  );
});
