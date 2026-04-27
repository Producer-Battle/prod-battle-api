// Public + auth-only achievement endpoints.
//
// GET  /achievements/catalogue       List the static catalogue (key, title, description)
// GET  /users/:handle/achievements   List a user's earned achievements (only non-hidden ones)
// GET  /me/achievements              List own earned achievements (includes hidden)
// PATCH /me/achievements/:key        Toggle hiddenByUser

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { CATALOGUE, getAchievement } from '../achievements/catalogue.js';
import { db } from '../db/client.js';
import { achievements, users } from '../db/schema.js';

export const achievementsRoutes = new OpenAPIHono();

const ErrorBody = z.object({ error: z.string(), message: z.string() });

const CatalogueItem = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.enum(['streak', 'milestone', 'tier', 'creator', 'community', 'mode']),
});

const EarnedItem = CatalogueItem.extend({
  earnedAt: z.string().datetime(),
  hiddenByUser: z.boolean(),
});

// ─── GET /achievements/catalogue ────────────────────────────────────────────

const catalogueRoute = createRoute({
  method: 'get',
  path: '/achievements/catalogue',
  tags: ['achievements'],
  summary: 'Static catalogue of every achievement',
  responses: {
    200: {
      description: 'Catalogue',
      content: {
        'application/json': { schema: z.object({ items: z.array(CatalogueItem) }) },
      },
    },
  },
});

achievementsRoutes.openapi(catalogueRoute, async (c) =>
  c.json({ items: CATALOGUE.map((m) => ({ ...m })) }, 200),
);

// ─── GET /users/:handle/achievements ────────────────────────────────────────

const publicRoute = createRoute({
  method: 'get',
  path: '/users/{handle}/achievements',
  tags: ['achievements'],
  summary: "List a user's public (non-hidden) achievements",
  request: {
    params: z.object({ handle: z.string() }),
  },
  responses: {
    200: {
      description: 'Earned achievements',
      content: {
        'application/json': { schema: z.object({ items: z.array(EarnedItem) }) },
      },
    },
    404: { description: 'User not found', content: { 'application/json': { schema: ErrorBody } } },
  },
});

achievementsRoutes.openapi(publicRoute, async (c) => {
  const { handle } = c.req.valid('param');
  const cleanHandle = handle.replace(/^@+/, '');
  const d = db();
  const [u] = await d.select().from(users).where(eq(users.handle, cleanHandle)).limit(1);
  if (!u) return c.json({ error: 'not_found', message: 'No such user.' }, 404);

  const rows = await d
    .select()
    .from(achievements)
    .where(and(eq(achievements.userId, u.id), eq(achievements.hiddenByUser, false)));
  return c.json(
    {
      items: rows.flatMap((r) => {
        const meta = getAchievement(r.achievementKey);
        if (!meta) return [];
        return [
          {
            ...meta,
            earnedAt: r.earnedAt.toISOString(),
            hiddenByUser: r.hiddenByUser,
          },
        ];
      }),
    },
    200,
  );
});

// ─── GET /me/achievements ───────────────────────────────────────────────────

const myRoute = createRoute({
  method: 'get',
  path: '/me/achievements',
  tags: ['achievements'],
  summary: 'List own achievements (including hidden)',
  responses: {
    200: {
      description: 'Earned achievements',
      content: {
        'application/json': { schema: z.object({ items: z.array(EarnedItem) }) },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: ErrorBody } },
    },
  },
});

achievementsRoutes.openapi(myRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);

  const rows = await db().select().from(achievements).where(eq(achievements.userId, user.id));
  return c.json(
    {
      items: rows.flatMap((r) => {
        const meta = getAchievement(r.achievementKey);
        if (!meta) return [];
        return [
          {
            ...meta,
            earnedAt: r.earnedAt.toISOString(),
            hiddenByUser: r.hiddenByUser,
          },
        ];
      }),
    },
    200,
  );
});

// ─── PATCH /me/achievements/:key ────────────────────────────────────────────

const PatchBody = z.object({ hidden: z.boolean() });

const patchRoute = createRoute({
  method: 'patch',
  path: '/me/achievements/{key}',
  tags: ['achievements'],
  summary: 'Toggle visibility of one of your achievements',
  request: {
    params: z.object({ key: z.string() }),
    body: { content: { 'application/json': { schema: PatchBody } } },
  },
  responses: {
    200: {
      description: 'Updated',
      content: {
        'application/json': { schema: z.object({ key: z.string(), hidden: z.boolean() }) },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: ErrorBody } },
    },
    404: {
      description: 'Achievement not earned',
      content: { 'application/json': { schema: ErrorBody } },
    },
  },
});

achievementsRoutes.openapi(patchRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);

  const { key } = c.req.valid('param');
  const { hidden } = c.req.valid('json');

  const d = db();
  const result = await d
    .update(achievements)
    .set({ hiddenByUser: hidden })
    .where(and(eq(achievements.userId, user.id), eq(achievements.achievementKey, key)))
    .returning();
  if (result.length === 0)
    return c.json({ error: 'not_earned', message: "You haven't earned that achievement." }, 404);

  return c.json({ key, hidden }, 200);
});
