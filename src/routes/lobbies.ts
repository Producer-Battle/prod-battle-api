// Lobby browser - lists all matches in lobby phase that are visible.
//
//   GET /lobbies - matches in status='lobby' that are public.
//
// Visibility rules:
//   - Quickplay/ranked/flip/daily/tournament: always visible (default is_public=TRUE).
//   - Private: hidden unless the host opted in (is_public=TRUE on create).
//
// The matchmaker on POST /matches still does cluster/anti-smurf filtering for
// auto-join. Explicit join (clicking a row in the browser) hits POST /matches
// with the existing matchmaking path; if a player can't legally join (full,
// cluster collision), the create call falls through to a fresh lobby just
// like a quickplay request would.

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export const lobbiesRoutes = new OpenAPIHono();

const lobbiesListRoute = createRoute({
  method: 'get',
  path: '/lobbies',
  tags: ['matches'],
  summary: 'Open and visible lobbies',
  responses: {
    200: {
      description: 'Lobbies (may be empty)',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(
              z.object({
                matchId: z.string().uuid(),
                roomCode: z.string(),
                mode: z.enum(['quickplay', 'ranked', 'private', 'flip', 'daily', 'tournament']),
                genre: z.object({ slug: z.string(), name: z.string() }),
                host: z.object({ handle: z.string() }).nullable(),
                playerCount: z.number().int(),
                capacity: z.number().int(),
                createdAt: z.string(),
              }),
            ),
          }),
        },
      },
    },
  },
});

lobbiesRoutes.openapi(lobbiesListRoute, async (c) => {
  const d = db();

  const rows = await d.execute<{
    match_id: string;
    room_code: string;
    mode: 'quickplay' | 'ranked' | 'private' | 'flip' | 'daily' | 'tournament';
    genre_slug: string;
    genre_name: string;
    host_handle: string | null;
    player_count: string;
    capacity: number;
    created_at: string;
  }>(
    sql`SELECT m.id AS match_id,
               m.room_code,
               m.mode,
               g.slug AS genre_slug,
               g.name AS genre_name,
               u.handle AS host_handle,
               COUNT(mp.user_id) AS player_count,
               (m.team_size * m.team_count) AS capacity,
               m.created_at
          FROM matches m
          JOIN genres g ON g.id = m.primary_genre_id
          LEFT JOIN users u ON u.id = m.host_id
          LEFT JOIN match_players mp ON mp.match_id = m.id
         WHERE m.status = 'lobby'
           AND m.is_public = TRUE
           AND m.room_code IS NOT NULL
         GROUP BY m.id, g.slug, g.name, u.handle
         ORDER BY m.created_at DESC
         LIMIT 50`,
  );

  return c.json({
    items: rows.map((r) => ({
      matchId: r.match_id,
      roomCode: r.room_code,
      mode: r.mode,
      genre: { slug: r.genre_slug, name: r.genre_name },
      host: r.host_handle ? { handle: r.host_handle } : null,
      playerCount: Number(r.player_count),
      capacity: r.capacity,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  });
});
