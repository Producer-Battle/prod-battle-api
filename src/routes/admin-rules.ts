// Admin endpoints for the game_rules table. Lets a trusted operator tune
// honor / tier / voting / achievement / reconnect knobs without shipping
// code. Every category is a free-form JSON blob - the loader types it on
// read; we accept any object on write and trust the admin to pass valid
// shapes (with a TS-typed editor on the frontend the risk is low).
// A future iteration can add per-category zod schemas.

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { gameRules } from '../db/schema.js';
import { setCategory } from '../game-rules/loader.js';

export const adminRulesRoutes = new OpenAPIHono();

const AdminError = z.object({ error: z.string(), message: z.string() });

const CATEGORIES = ['honor', 'tiers', 'voting', 'achievements', 'reconnect'] as const;
const CategoryEnum = z.enum(CATEGORIES);

const requireAdmin = (
  c: Parameters<Parameters<typeof adminRulesRoutes.openapi>[1]>[0],
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

// ─── GET /admin/rules ───────────────────────────────────────────────────────

const RuleRow = z.object({
  category: CategoryEnum,
  payload: z.record(z.string(), z.unknown()),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().uuid().nullable(),
});

const listRoute = createRoute({
  method: 'get',
  path: '/admin/rules',
  tags: ['admin', 'rules'],
  summary: 'List all tunable game rules categories',
  responses: {
    200: {
      description: 'All rule rows',
      content: {
        'application/json': {
          schema: z.object({ items: z.array(RuleRow) }),
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

adminRulesRoutes.openapi(listRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const rows = await db().select().from(gameRules).orderBy(asc(gameRules.category));
  return c.json(
    {
      items: rows.map((r) => ({
        category: r.category as (typeof CATEGORIES)[number],
        payload: r.payload as Record<string, unknown>,
        updatedAt: r.updatedAt.toISOString(),
        updatedBy: r.updatedBy,
      })),
    },
    200,
  );
});

// ─── PUT /admin/rules/:category ─────────────────────────────────────────────

const UpdateBody = z.object({
  payload: z.record(z.string(), z.unknown()),
});

const updateRoute = createRoute({
  method: 'put',
  path: '/admin/rules/{category}',
  tags: ['admin', 'rules'],
  summary: 'Replace the payload for a rules category',
  request: {
    params: z.object({ category: CategoryEnum }),
    body: { content: { 'application/json': { schema: UpdateBody } } },
  },
  responses: {
    200: {
      description: 'Updated',
      content: { 'application/json': { schema: RuleRow } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Not an admin', content: { 'application/json': { schema: AdminError } } },
    400: {
      description: 'Invalid payload',
      content: { 'application/json': { schema: AdminError } },
    },
  },
});

adminRulesRoutes.openapi(updateRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { category } = c.req.valid('param');
  const { payload } = c.req.valid('json');

  // Use the loader's setter so the in-process cache is invalidated.
  await setCategory(category, payload as never, g.userId);

  const [row] = await db()
    .select()
    .from(gameRules)
    .where(eq(gameRules.category, category))
    .limit(1);
  if (!row) return c.json({ error: 'not_found', message: 'Rule disappeared.' }, 400);

  return c.json(
    {
      category,
      payload: row.payload as Record<string, unknown>,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    },
    200,
  );
});
