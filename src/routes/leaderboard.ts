// GET /leaderboard
//
// Simple scoreboard derived from the submissions + matches tables. No
// pre-computed ranking rows — we aggregate on read so new matches show
// up immediately, at the cost of one group-by per request. Fine while the
// match volume is small; swap for a materialised view if it ever isn't.
//
// Scoring:
//   +10 points per win  (submission.final_rank = 1)
//   + 1 point  per match played
//
// Filters: mode (quickplay/ranked/private/tournament/practice) + optional
// genreSlug. A "me" row is returned separately so the UI can pin it to
// the top even when the caller isn't in the top N.

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export const leaderboardRoutes = new OpenAPIHono();

const LeaderRow = z
  .object({
    rank: z.number().int(),
    userId: z.string().uuid(),
    handle: z.string(),
    avatarUrl: z.string().nullable(),
    matchesPlayed: z.number().int(),
    wins: z.number().int(),
    points: z.number().int(),
  })
  .openapi('LeaderRow');

const leaderboardRoute = createRoute({
  method: 'get',
  path: '/leaderboard',
  tags: ['leaderboard'],
  summary: 'Scoreboard for a given mode + optional genre',
  request: {
    query: z.object({
      mode: z.enum(['quickplay', 'ranked', 'private', 'tournament', 'practice']).optional(),
      genreSlug: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  },
  responses: {
    200: {
      description: "Leaderboard + (if authed) the caller's own row",
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(LeaderRow),
            me: LeaderRow.nullable(),
          }),
        },
      },
    },
  },
});

leaderboardRoutes.openapi(leaderboardRoute, async (c) => {
  const { mode, genreSlug, limit } = c.req.valid('query');
  const user = c.var.user;
  const d = db();

  const rows = await d.execute<{
    user_id: string;
    handle: string;
    avatar_url: string | null;
    matches_played: string;
    wins: string;
    points: string;
  }>(sql`
    WITH scored AS (
      SELECT s.user_id,
             COUNT(DISTINCT s.match_id) AS matches_played,
             COUNT(*) FILTER (WHERE s.final_rank = 1) AS wins
        FROM submissions s
        JOIN matches m ON m.id = s.match_id
        LEFT JOIN genres g ON g.id = m.primary_genre_id
       WHERE m.status = 'results'
         AND (${mode ?? null}::match_mode IS NULL OR m.mode = ${mode ?? null}::match_mode)
         AND (${genreSlug ?? null}::text IS NULL OR g.slug = ${genreSlug ?? null})
       GROUP BY s.user_id
    )
    SELECT u.id AS user_id,
           u.handle,
           u.avatar_url,
           sc.matches_played::text,
           sc.wins::text,
           (sc.wins * 10 + sc.matches_played)::text AS points
      FROM scored sc
      JOIN users u ON u.id = sc.user_id
     ORDER BY points DESC, wins DESC, matches_played DESC, u.handle ASC
     LIMIT ${limit}
  `);

  const items = rows.map((r, i) => ({
    rank: i + 1,
    userId: r.user_id,
    handle: r.handle,
    avatarUrl: r.avatar_url,
    matchesPlayed: Number(r.matches_played),
    wins: Number(r.wins),
    points: Number(r.points),
  }));

  // Pull the caller's row separately (and compute their rank across the
  // unlimited list, not just the top `limit`). Null for anon requests.
  let me: z.infer<typeof LeaderRow> | null = null;
  if (user) {
    const [myRow] = await d.execute<{
      matches_played: string;
      wins: string;
      points: string;
      rank: string;
    }>(sql`
      WITH scored AS (
        SELECT s.user_id,
               COUNT(DISTINCT s.match_id) AS matches_played,
               COUNT(*) FILTER (WHERE s.final_rank = 1) AS wins
          FROM submissions s
          JOIN matches m ON m.id = s.match_id
          LEFT JOIN genres g ON g.id = m.primary_genre_id
         WHERE m.status = 'results'
           AND (${mode ?? null}::match_mode IS NULL OR m.mode = ${mode ?? null}::match_mode)
           AND (${genreSlug ?? null}::text IS NULL OR g.slug = ${genreSlug ?? null})
         GROUP BY s.user_id
      ),
      ranked AS (
        SELECT user_id, matches_played, wins,
               (wins * 10 + matches_played) AS points,
               RANK() OVER (ORDER BY (wins * 10 + matches_played) DESC,
                                     wins DESC, matches_played DESC) AS rank
          FROM scored
      )
      SELECT matches_played::text, wins::text, points::text, rank::text
        FROM ranked
       WHERE user_id = ${user.id}
    `);
    if (myRow) {
      me = {
        rank: Number(myRow.rank),
        userId: user.id,
        handle: user.handle ?? '',
        avatarUrl: null,
        matchesPlayed: Number(myRow.matches_played),
        wins: Number(myRow.wins),
        points: Number(myRow.points),
      };
    }
  }

  return c.json({ items, me }, 200);
});
