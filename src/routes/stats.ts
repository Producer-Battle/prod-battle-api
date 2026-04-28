// Public, unauthenticated stats for the live-activity pill in the web header.
// Polled every ~20s; queries are cheap (one indexed count + one distinct
// count joining match_players to active matches). No personal data leaves.

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, countDistinct, gt, inArray, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { matchPlayers, matches, sessions } from '../db/schema.js';

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
      .where(gt(sessions.expiresAt, new Date()))
      .then((rows) => rows[0]?.n ?? 0),
  ]);
  return c.json({
    liveBattles: Number(battles),
    producersActive: Number(producers),
    producersOnline: Number(online),
  });
});
