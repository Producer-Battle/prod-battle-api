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
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creatorPayouts } from '../db/schema.js';
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

// ─── GET /admin/payouts/snapshots ────────────────────────────────────────────
//
// List the periodic snapshots written by the monthly cron, newest first.
// Use this to drive the admin payouts table that shows status=pending /
// rolled / paid per (creator, period).

const SnapshotRow = z.object({
  id: z.string().uuid(),
  creatorId: z.string().uuid(),
  creatorHandle: z.string(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  plays: z.number().int(),
  amountCents: z.number().int(),
  status: z.enum(['pending', 'paid', 'rolled', 'cancelled']),
  paidAt: z.string().datetime().nullable(),
  externalRef: z.string().nullable(),
});

const snapshotsRoute = createRoute({
  method: 'get',
  path: '/admin/payouts/snapshots',
  tags: ['admin', 'payouts'],
  summary: 'List monthly creator-payout snapshots',
  responses: {
    200: {
      description: 'Snapshots',
      content: {
        'application/json': { schema: z.object({ items: z.array(SnapshotRow) }) },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Not an admin', content: { 'application/json': { schema: AdminError } } },
  },
});

adminPayoutsRoutes.openapi(snapshotsRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const rows = await db().execute<{
    id: string;
    creator_id: string;
    handle: string;
    period_start: Date;
    period_end: Date;
    plays: number;
    amount_cents: number;
    status: string;
    paid_at: Date | null;
    external_ref: string | null;
  }>(
    sql`SELECT cp.id, cp.creator_id, u.handle,
               cp.period_start, cp.period_end, cp.plays, cp.amount_cents,
               cp.status, cp.paid_at, cp.external_ref
          FROM creator_payouts cp
          JOIN users u ON u.id = cp.creator_id
         ORDER BY cp.period_start DESC, cp.amount_cents DESC
         LIMIT 200`,
  );
  const arr = rows as Array<{
    id: string;
    creator_id: string;
    handle: string;
    period_start: Date | string;
    period_end: Date | string;
    plays: number;
    amount_cents: number;
    status: string;
    paid_at: Date | string | null;
    external_ref: string | null;
  }>;
  return c.json(
    {
      items: arr.map((r) => ({
        id: r.id,
        creatorId: r.creator_id,
        creatorHandle: r.handle,
        periodStart: new Date(r.period_start).toISOString(),
        periodEnd: new Date(r.period_end).toISOString(),
        plays: Number(r.plays),
        amountCents: Number(r.amount_cents),
        status: r.status as 'pending' | 'paid' | 'rolled' | 'cancelled',
        paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
        externalRef: r.external_ref,
      })),
    },
    200,
  );
});

// ─── PATCH /admin/payouts/snapshots/:id ──────────────────────────────────────
//
// Admin can edit amount_cents (when revenue lands), mark a row as paid
// (with externalRef = Mollie payment id), or override status to cancelled.

const PatchSnapshotBody = z.object({
  amountCents: z.number().int().nonnegative().optional(),
  status: z.enum(['pending', 'paid', 'rolled', 'cancelled']).optional(),
  externalRef: z.string().nullable().optional(),
});

const patchSnapshotRoute = createRoute({
  method: 'patch',
  path: '/admin/payouts/snapshots/{id}',
  tags: ['admin', 'payouts'],
  summary: 'Adjust or close a creator-payout snapshot',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: PatchSnapshotBody } } },
  },
  responses: {
    200: {
      description: 'Updated',
      content: { 'application/json': { schema: z.object({ id: z.string().uuid() }) } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Not an admin', content: { 'application/json': { schema: AdminError } } },
    404: {
      description: 'Snapshot not found',
      content: { 'application/json': { schema: AdminError } },
    },
  },
});

adminPayoutsRoutes.openapi(patchSnapshotRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { id } = c.req.valid('param');
  const body = c.req.valid('json');

  const update: Partial<typeof creatorPayouts.$inferInsert> = {};
  if (body.amountCents !== undefined) update.amountCents = body.amountCents;
  if (body.status !== undefined) {
    update.status = body.status;
    if (body.status === 'paid') update.paidAt = new Date();
  }
  if (body.externalRef !== undefined) update.externalRef = body.externalRef;
  if (Object.keys(update).length === 0)
    return c.json({ error: 'no_changes', message: 'Nothing to update.' }, 404);

  const result = await db()
    .update(creatorPayouts)
    .set(update)
    .where(eq(creatorPayouts.id, id))
    .returning({ id: creatorPayouts.id });
  const row = result[0];
  if (!row) return c.json({ error: 'not_found', message: 'No such snapshot.' }, 404);

  return c.json({ id: row.id }, 200);
});

// `desc` import is consumed by drizzle's query builder above; keep it
// in scope so future helpers (e.g., paginated snapshots) can use it.
void desc;

// ─── GET /admin/payouts/pending ─────────────────────────────────────────────
//
// Settle-ready list: pending creator_payouts joined with the creator's
// payoutEmail/payoutIban so an operator can run a SEPA bank transfer
// (or future Mollie Connect call) and then PATCH the row to status='paid'.
// Excludes rows with no payout preference set - those still appear in
// the snapshots view but can't be settled until the creator fills in
// their bank details.

const PendingRow = z.object({
  id: z.string().uuid(),
  creatorId: z.string().uuid(),
  creatorHandle: z.string(),
  payoutEmail: z.string().nullable(),
  payoutIban: z.string().nullable(),
  amountCents: z.number().int(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
});

const pendingRoute = createRoute({
  method: 'get',
  path: '/admin/payouts/pending',
  tags: ['admin', 'payouts'],
  summary: 'Settle-ready creator payouts (status=pending, payout details set)',
  responses: {
    200: {
      description: 'Pending settle queue',
      content: {
        'application/json': { schema: z.object({ items: z.array(PendingRow) }) },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Not an admin', content: { 'application/json': { schema: AdminError } } },
  },
});

adminPayoutsRoutes.openapi(pendingRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const rows = await db().execute<{
    id: string;
    creator_id: string;
    handle: string;
    payout_email: string | null;
    payout_iban: string | null;
    amount_cents: number;
    period_start: Date | string;
    period_end: Date | string;
  }>(
    sql`SELECT cp.id, cp.creator_id, u.handle,
               u.payout_email, u.payout_iban,
               cp.amount_cents, cp.period_start, cp.period_end
          FROM creator_payouts cp
          JOIN users u ON u.id = cp.creator_id
         WHERE cp.status = 'pending'
           AND (u.payout_email IS NOT NULL OR u.payout_iban IS NOT NULL)
         ORDER BY cp.period_start ASC, cp.amount_cents DESC`,
  );
  const arr = rows as Array<{
    id: string;
    creator_id: string;
    handle: string;
    payout_email: string | null;
    payout_iban: string | null;
    amount_cents: number;
    period_start: Date | string;
    period_end: Date | string;
  }>;
  return c.json(
    {
      items: arr.map((r) => ({
        id: r.id,
        creatorId: r.creator_id,
        creatorHandle: r.handle,
        payoutEmail: r.payout_email,
        payoutIban: r.payout_iban,
        amountCents: Number(r.amount_cents),
        periodStart: new Date(r.period_start).toISOString(),
        periodEnd: new Date(r.period_end).toISOString(),
      })),
    },
    200,
  );
});
