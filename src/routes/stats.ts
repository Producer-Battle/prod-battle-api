// Public, unauthenticated stats for the live-activity pill in the web header.
// Polled every ~20s; queries are cheap (one indexed count + one distinct
// count joining match_players to active matches). No personal data leaves.

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, countDistinct, gt, inArray, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { matchPlayers, matches, sessions } from '../db/schema.js';

// "Online" window: a session whose updatedAt is within this many ms is
// considered actively present. better-auth bumps sessions.updatedAt on
// every authenticated request, so any tab making requests (the header
// pill polls /stats/live with credentials, the auth/get-session call from
// useSession also fires on focus) keeps the heartbeat alive.
//
// 3 minutes balances "real-time enough" against "tabs that idle for a
// minute don't disappear instantly". Tune as needed.
const ONLINE_WINDOW_MS = 3 * 60 * 1000;

export const statsRoutes = new OpenAPIHono();

const LiveStats = z
  .object({
    // Matches currently in any non-terminal state (lobby/submit/reveal/vote).
    liveBattles: z.number().int().nonnegative(),
    // Distinct users in those live battles. Subset of producersOnline.
    producersActive: z.number().int().nonnegative(),
    // Distinct users with a non-expired session - "online" in the loose sense
    // of "browser is signed in", not "currently playing". This is the number
    // the header pill shows so just being signed in registers as a heartbeat.
    producersOnline: z.number().int().nonnegative(),
  })
  .openapi('LiveStats');

// Anything not in the terminal 'results' state counts as "live" for the
// header pill. lobby+submit+reveal+vote all show signs of activity.
const LIVE_STATUSES = ['lobby', 'submit', 'reveal', 'vote'] as const;

const route = createRoute({
  method: 'get',
  path: '/stats/live',
  tags: ['system'],
  summary: 'Live activity counters for the header pill',
  responses: {
    200: {
      description: 'Counts of currently-active battles and the producers in them.',
      content: { 'application/json': { schema: LiveStats } },
    },
  },
});

statsRoutes.openapi(route, async (c) => {
  const d = db();
  const liveStatusList =
    LIVE_STATUSES as readonly (typeof LIVE_STATUSES)[number][] as (typeof LIVE_STATUSES)[number][];
  const [battles, producers, online] = await Promise.all([
    d
      .select({ n: countDistinct(matches.id) })
      .from(matches)
      .where(inArray(matches.status, liveStatusList))
      .then((rows) => rows[0]?.n ?? 0),
    d
      .select({ n: countDistinct(matchPlayers.userId) })
      .from(matchPlayers)
      .innerJoin(matches, and(ne(matches.status, 'results')))
      .where(inArray(matches.status, liveStatusList))
      .then((rows) => rows[0]?.n ?? 0),
    d
      .select({ n: countDistinct(sessions.userId) })
      .from(sessions)
      .where(
        and(
          gt(sessions.expiresAt, new Date()),
          gt(sessions.updatedAt, new Date(Date.now() - ONLINE_WINDOW_MS)),
        ),
      )
      .then((rows) => rows[0]?.n ?? 0),
  ]);
  return c.json({
    liveBattles: Number(battles),
    producersActive: Number(producers),
    producersOnline: Number(online),
  });
});
