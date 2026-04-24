// Self-serve profile endpoints for authenticated users.
//
// GET  /me            - full profile shape for the current user
// PATCH /me           - update handle and/or avatarUrl
// GET  /users/:handle - public profile for any active user (no email, no status)

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { signUrl } from '../audio/s3.js';
import { db } from '../db/client.js';
import { producerProfiles, submissions, users } from '../db/schema.js';
import { requireAuth } from '../middleware/session.js';

export const meRoutes = new OpenAPIHono();

// ─── GET /me ─────────────────────────────────────────────────────────────────

const MeResponse = z
  .object({
    id: z.string().uuid(),
    handle: z.string(),
    email: z.string().email(),
    role: z.enum(['producer', 'ar', 'admin']),
    plan: z.enum(['free', 'paid']),
    status: z.enum(['active', 'archived', 'deleted']),
    avatarUrl: z.string().nullable(),
    createdAt: z.string(),
    stats: z.object({
      totalMatches: z.number().int(),
      totalSubmissions: z.number().int(),
      bestRank: z.number().int().nullable(),
    }),
  })
  .openapi('MeResponse');

const getMeRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['profile'],
  summary: "Return the authenticated user's full profile",
  middleware: [requireAuth()] as const,
  responses: {
    200: {
      description: 'Profile',
      content: { 'application/json': { schema: MeResponse } },
    },
    401: { description: 'Unauthenticated' },
  },
});

meRoutes.openapi(getMeRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const d = db();

  const [row] = await d
    .select({
      id: users.id,
      handle: users.handle,
      email: users.email,
      role: users.role,
      plan: users.plan,
      status: users.status,
      avatarUrl: users.avatarUrl,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  if (!row) return c.json({ error: 'user not found' }, 404);

  const [stats] = await d.execute<{
    total_matches: string;
    total_submissions: string;
    best_rank: string | null;
  }>(
    sql`SELECT
          COUNT(DISTINCT s.match_id)::text AS total_matches,
          COUNT(s.id)::text AS total_submissions,
          MIN(s.final_rank)::text AS best_rank
        FROM submissions s
        WHERE s.user_id = ${user.id}`,
  );

  return c.json(
    {
      id: row.id,
      handle: row.handle,
      email: row.email,
      role: row.role,
      plan: row.plan,
      status: row.status,
      avatarUrl: row.avatarUrl ?? null,
      createdAt: row.createdAt.toISOString(),
      stats: {
        totalMatches: Number(stats?.total_matches ?? 0),
        totalSubmissions: Number(stats?.total_submissions ?? 0),
        bestRank: stats?.best_rank != null ? Number(stats.best_rank) : null,
      },
    },
    200,
  );
});

// ─── PATCH /me ───────────────────────────────────────────────────────────────

const HANDLE_RE = /^[a-zA-Z0-9_-]{3,20}$/;

const PatchMeBody = z
  .object({
    handle: z.string().regex(HANDLE_RE, 'Handle must be 3-20 chars [a-zA-Z0-9_-]').optional(),
    avatarUrl: z.string().url('avatarUrl must be a valid URL').nullable().optional(),
  })
  .openapi('PatchMeBody');

const patchMeRoute = createRoute({
  method: 'patch',
  path: '/me',
  tags: ['profile'],
  summary: 'Update handle and/or avatar URL',
  middleware: [requireAuth()] as const,
  request: {
    body: { content: { 'application/json': { schema: PatchMeBody } } },
  },
  responses: {
    200: {
      description: 'Updated profile',
      content: { 'application/json': { schema: MeResponse } },
    },
    400: { description: 'Validation error' },
    401: { description: 'Unauthenticated' },
    409: { description: 'Handle already taken' },
  },
});

meRoutes.openapi(patchMeRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const body = c.req.valid('json');
  const d = db();

  const updates: { handle?: string; avatarUrl?: string | null } = {};

  if (body.handle !== undefined) {
    const normalised = body.handle.toLowerCase();
    // Check uniqueness - exclude own row so no-change is a no-op.
    const [taken] = await d.execute<{ id: string }>(
      sql`SELECT id FROM users WHERE handle = ${normalised} AND id != ${user.id} LIMIT 1`,
    );
    if (taken) {
      return c.json({ error: 'handle_taken', message: 'That handle is already taken.' }, 409);
    }
    updates.handle = normalised;
  }

  if (body.avatarUrl !== undefined) {
    updates.avatarUrl = body.avatarUrl;
  }

  if (Object.keys(updates).length > 0) {
    await d
      .update(users)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }

  const [row] = await d
    .select({
      id: users.id,
      handle: users.handle,
      email: users.email,
      role: users.role,
      plan: users.plan,
      status: users.status,
      avatarUrl: users.avatarUrl,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  if (!row) return c.json({ error: 'user not found' }, 404);

  const [stats] = await d.execute<{
    total_matches: string;
    total_submissions: string;
    best_rank: string | null;
  }>(
    sql`SELECT
          COUNT(DISTINCT s.match_id)::text AS total_matches,
          COUNT(s.id)::text AS total_submissions,
          MIN(s.final_rank)::text AS best_rank
        FROM submissions s
        WHERE s.user_id = ${user.id}`,
  );

  return c.json(
    {
      id: row.id,
      handle: row.handle,
      email: row.email,
      role: row.role,
      plan: row.plan,
      status: row.status,
      avatarUrl: row.avatarUrl ?? null,
      createdAt: row.createdAt.toISOString(),
      stats: {
        totalMatches: Number(stats?.total_matches ?? 0),
        totalSubmissions: Number(stats?.total_submissions ?? 0),
        bestRank: stats?.best_rank != null ? Number(stats.best_rank) : null,
      },
    },
    200,
  );
});

// ─── GET /users/:handle ──────────────────────────────────────────────────────

const PublicSubmission = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
  audioUrl: z.string().url(),
  score: z.number(),
  rank: z.number().int().nullable(),
  mode: z.string(),
  createdAt: z.string(),
});

const PublicProfileResponse = z
  .object({
    handle: z.string(),
    avatarUrl: z.string().nullable(),
    role: z.enum(['producer', 'ar', 'admin']),
    bio: z.string().nullable(),
    createdAt: z.string(),
    recentSubmissions: z.array(PublicSubmission),
  })
  .openapi('PublicProfileResponse');

const getUserRoute = createRoute({
  method: 'get',
  path: '/users/{handle}',
  tags: ['profile'],
  summary: 'Public profile for an active user',
  request: { params: z.object({ handle: z.string() }) },
  responses: {
    200: {
      description: 'Public profile',
      content: { 'application/json': { schema: PublicProfileResponse } },
    },
    404: { description: 'User not found or not active' },
  },
});

meRoutes.openapi(getUserRoute, async (c) => {
  const { handle } = c.req.valid('param');
  // Defensive: strip a leading `@` users often paste in URLs, and lowercase.
  // Our canonical handle is bare ASCII - see HANDLE_RE on PatchMeBody.
  const normalised = handle.replace(/^@+/, '').toLowerCase();
  const d = db();

  const [row] = await d
    .select({
      id: users.id,
      handle: users.handle,
      role: users.role,
      avatarUrl: users.avatarUrl,
      status: users.status,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.handle, normalised))
    .limit(1);

  if (!row || row.status !== 'active') {
    return c.json({ error: 'not found' }, 404);
  }

  // Fetch bio from producer_profiles (may not exist yet for all users).
  const [profile] = await d
    .select({ bio: producerProfiles.bio })
    .from(producerProfiles)
    .where(eq(producerProfiles.userId, row.id))
    .limit(1);

  // Top 10 recent submissions with match mode.
  const subRows = await d.execute<{
    id: string;
    title: string | null;
    audio_url: string;
    score: string;
    final_rank: number | null;
    mode: string;
    created_at: string;
  }>(
    sql`SELECT s.id, s.title, s.audio_url, s.score::text, s.final_rank,
               m.mode, s.created_at::text
          FROM submissions s
          JOIN matches m ON m.id = s.match_id
         WHERE s.user_id = ${row.id}
           AND s.is_public = true
         ORDER BY s.created_at DESC
         LIMIT 10`,
  );

  const recentSubmissions = await Promise.all(
    subRows.map(async (s) => ({
      id: s.id,
      title: s.title,
      audioUrl: await signUrl(s.audio_url, 3600),
      score: Number(s.score),
      rank: s.final_rank ?? null,
      mode: s.mode,
      createdAt: s.created_at,
    })),
  );

  return c.json({
    handle: row.handle,
    avatarUrl: row.avatarUrl ?? null,
    role: row.role,
    bio: profile?.bio ?? null,
    createdAt: row.createdAt.toISOString(),
    recentSubmissions,
  });
});
