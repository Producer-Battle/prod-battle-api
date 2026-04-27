// Admin endpoints for the pack-creator revenue share.
//
// Pool size = creatorPoolPercentOfPremium% of premium subscription
// revenue this period. Each creator gets:
//   payout = pool * (their_plays / total_plays)
//
// Premium revenue plumbing isn't built yet - until it is, the pool size
// is supplied as a query param so admins can preview distributions for a
// given pool. When billing wires through the actual revenue total we'll
// flip the param to optional + auto-compute.
//
// Endpoints:
//   GET /admin/pack-payouts?since=ISO&until=ISO&poolCents=N
//     Returns the per-creator payout breakdown for the window.

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { getCategory } from '../game-rules/loader.js';

export const adminPayoutsRoutes = new OpenAPIHono();

const AdminError = z.object({ error: z.string(), message: z.string() });

const PayoutRow = z.object({
  creatorId: z.string().uuid(),
  creatorHandle: z.string(),
  plays: z.number().int(),
  shareOfPool: z.number(),
  payoutCents: z.number().int(),
  belowThreshold: z.boolean(),
});

const requireAdmin = (
  c: Parameters<Parameters<typeof adminPayoutsRoutes.openapi>[1]>[0],
):
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; body: { error: string; message: string } } => {
  const user = c.var.user;
  if (!user)
    return { ok: false, status: 401, body: { error: 'unauthenticated', message: 'Sign in.' } };
  if (user.role !== 'admin')
    return {
      ok: false,
      status: 403,
      body: { error: 'forbidden', message: 'Admin role required.' },
    };
  return { ok: true, userId: user.id };
};

const payoutRoute = createRoute({
  method: 'get',
  path: '/admin/pack-payouts',
  tags: ['admin', 'payouts'],
  summary: 'Compute creator-revenue payout breakdown for a window',
  request: {
    query: z.object({
      since: z.string().datetime().optional(),
      until: z.string().datetime().optional(),
      poolCents: z.coerce.number().int().nonnegative().optional().default(0),
    }),
  },
  responses: {
    200: {
      description: 'Per-creator breakdown',
      content: {
        'application/json': {
          schema: z.object({
            window: z.object({
              since: z.string().datetime(),
              until: z.string().datetime(),
            }),
            poolCents: z.number().int(),
            totalPlays: z.number().int(),
            minPayoutCents: z.number().int(),
            rolloverIfBelow: z.boolean(),
            rows: z.array(PayoutRow),
          }),
        },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Not an admin', content: { 'application/json': { schema: AdminError } } },
  },
});

adminPayoutsRoutes.openapi(payoutRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const q = c.req.valid('query');
  const now = new Date();
  const sinceDate = q.since ? new Date(q.since) : new Date(now.getTime() - 30 * 86400 * 1000);
  const untilDate = q.until ? new Date(q.until) : now;
  const poolCents = Math.max(0, Math.round(q.poolCents ?? 0));

  const revenueRules = await getCategory('revenue');
  const minPayoutCents = revenueRules.minPayoutThresholdCents;
  const rolloverIfBelow = revenueRules.rolloverIfBelow;

  // Per-creator play counts in the window. Only count plays of POOL packs
  // (kind='pool') with a non-null creator. Pool packs are the only ones
  // every player can use, so they're the only ones eligible for payout.
  const rows = await db().execute<{
    creator_id: string;
    handle: string;
    plays: string;
  }>(
    sql`SELECT sp.created_by AS creator_id, u.handle, COUNT(*)::text AS plays
          FROM pack_plays pp
          JOIN sample_packs sp ON sp.id = pp.pack_id
          JOIN users u ON u.id = sp.created_by
         WHERE sp.kind = 'pool'
           AND sp.created_by IS NOT NULL
           AND pp.played_at >= ${sinceDate.toISOString()}::timestamptz
           AND pp.played_at <  ${untilDate.toISOString()}::timestamptz
         GROUP BY sp.created_by, u.handle
         ORDER BY plays DESC`,
  );
  const arr = rows as Array<{ creator_id: string; handle: string; plays: string }>;
  const totalPlays = arr.reduce((acc, r) => acc + Number(r.plays), 0);

  const breakdown = arr.map((r) => {
    const plays = Number(r.plays);
    const share = totalPlays > 0 ? plays / totalPlays : 0;
    const payoutCents = Math.floor(poolCents * share);
    return {
      creatorId: r.creator_id,
      creatorHandle: r.handle,
      plays,
      shareOfPool: share,
      payoutCents,
      belowThreshold: payoutCents < minPayoutCents,
    };
  });

  return c.json(
    {
      window: { since: sinceDate.toISOString(), until: untilDate.toISOString() },
      poolCents,
      totalPlays,
      minPayoutCents,
      rolloverIfBelow,
      rows: breakdown,
    },
    200,
  );
});
