// Self-serve profile endpoints for authenticated users.
//
// GET  /me                      - full profile shape for the current user
// PATCH /me                     - update handle and/or avatarUrl
// POST /me/claim-guest-handle   - merge a guest identity into the caller's account
// GET  /users/:handle           - public profile for any active user (no email, no status)

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { signUrl } from '../audio/s3.js';
import { db } from '../db/client.js';
import {
  accounts,
  matchPlayers,
  producerProfiles,
  sessions,
  submissions,
  users,
  votes,
} from '../db/schema.js';
import { env } from '../env.js';
import { requireAuth } from '../middleware/session.js';

// ─── Lazy Redis client (reuse the same env var as rate-limit.ts) ─────────────

let _claimRedis: Redis | null = null;

function getClaimRedis(): Redis {
  if (!_claimRedis) {
    const url = env.REDIS_URL ?? 'redis://localhost:6379';
    _claimRedis = new Redis(url, {
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      maxRetriesPerRequest: 1,
    });
    _claimRedis.on('error', (err: Error) => {
      console.warn('[claim-guest] redis error:', err.message);
    });
  }
  return _claimRedis;
}

// Exported for tests that need to reset module-level state between cases.
export function _resetClaimRedisForTest(): void {
  _claimRedis = null;
}

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

// ─── POST /me/claim-guest-handle ────────────────────────────────────────────

const ClaimGuestHandleBody = z
  .object({
    guestHandle: z.string().min(1).max(64),
  })
  .openapi('ClaimGuestHandleBody');

const ClaimGuestHandleResponse = z
  .object({
    newHandle: z.string(),
    stats: z.object({
      matchesMerged: z.number().int(),
      submissionsMerged: z.number().int(),
      votesMerged: z.number().int(),
    }),
  })
  .openapi('ClaimGuestHandleResponse');

const claimGuestHandleRoute = createRoute({
  method: 'post',
  path: '/me/claim-guest-handle',
  tags: ['profile'],
  summary: 'Merge a guest handle and its history into the authenticated account',
  middleware: [requireAuth()] as const,
  request: {
    body: { content: { 'application/json': { schema: ClaimGuestHandleBody } } },
  },
  responses: {
    200: {
      description: 'Claim succeeded - handle updated, history merged',
      content: { 'application/json': { schema: ClaimGuestHandleResponse } },
    },
    400: { description: 'Handle collision or validation error' },
    401: { description: 'Unauthenticated' },
    404: { description: 'Guest not found' },
    409: { description: 'Already claimed or target is a real account' },
    429: { description: 'Rate limited - only 1 claim per 24h' },
  },
});

meRoutes.openapi(claimGuestHandleRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  const { guestHandle } = c.req.valid('json');
  const normalised = guestHandle.toLowerCase();
  const callerId = user.id;

  // ── Rate limit: 1 claim per user per 24h ─────────────────────────────────
  const rlKey = `rl:claim-guest:${callerId}`;
  try {
    const redis = getClaimRedis();
    const count = await redis.incr(rlKey);
    if (count === 1) {
      await redis.expire(rlKey, 86_400);
    }
    if (count > 1) {
      return c.json(
        {
          error: 'already_claimed_recently',
          message: 'You may only claim one guest handle per 24 hours.',
        },
        429,
      );
    }
  } catch (err) {
    // Redis unavailable - fail-open so the operation is still allowed.
    console.warn('[claim-guest] redis unavailable, skipping rate limit:', (err as Error).message);
  }

  const d = db();

  // ── Look up the target guest row ─────────────────────────────────────────
  const [target] = await d
    .select({
      id: users.id,
      email: users.email,
      status: users.status,
    })
    .from(users)
    .where(eq(users.handle, normalised))
    .limit(1);

  if (!target) {
    return c.json(
      { error: 'guest_not_found', message: `No user found with handle "${normalised}".` },
      404,
    );
  }

  // Caller must not be claiming themselves.
  if (target.id === callerId) {
    return c.json({ error: 'guest_not_found', message: 'Cannot claim your own handle.' }, 404);
  }

  // Target must be a guest (email ends in @guest.local).
  if (!target.email.endsWith('@guest.local')) {
    return c.json(
      {
        error: 'guest_is_real_account',
        message: 'That handle belongs to a real account and cannot be claimed.',
      },
      409,
    );
  }

  // Target must be active.
  if (target.status !== 'active') {
    return c.json(
      { error: 'guest_not_found', message: `No active user found with handle "${normalised}".` },
      404,
    );
  }

  // Target must not have an accounts row (password/OAuth-backed).
  const [targetAccount] = await d
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.userId, target.id))
    .limit(1);

  if (targetAccount) {
    return c.json(
      {
        error: 'guest_is_real_account',
        message: 'That handle belongs to a real account and cannot be claimed.',
      },
      409,
    );
  }

  // Target must not have any valid (non-expired) sessions.
  const [liveSession] = await d.execute<{ id: string }>(
    sql`SELECT id FROM sessions WHERE user_id = ${target.id} AND expires_at > now() LIMIT 1`,
  );
  if (liveSession) {
    return c.json(
      {
        error: 'guest_is_real_account',
        message: 'That handle has active sessions and cannot be claimed.',
      },
      409,
    );
  }

  // ── Check that the caller's current handle is not already "guestHandle"
  // (edge case: caller already holds the target handle - treat as success-like
  // scenario but as a collision to be safe).
  // Also: check there's no OTHER non-guest user holding the handle who isn't
  // the target. In practice this can't happen (handle is unique), but if
  // someone else took it between the guest lookup and now, we should 400.
  // The unique index on users.handle guarantees target is the only holder.
  // We only need to guard against the caller already holding it.
  if (user.handle === normalised) {
    return c.json({ error: 'handle_collision', message: 'You already use that handle.' }, 400);
  }

  // ── Transactionally merge and rename ─────────────────────────────────────
  const { matchesMerged, submissionsMerged, votesMerged } = await d.transaction(async (tx) => {
    // Reassign match_players rows only where the caller doesn't already
    // occupy that match (PK is (match_id, user_id)). Rows where the caller
    // IS already in that match are left on the guest; the guest DELETE below
    // cascades and removes them.
    const mpRows = await tx.execute<{ match_id: string }>(
      sql`UPDATE match_players mp
          SET user_id = ${callerId}
          WHERE mp.user_id = ${target.id}
            AND NOT EXISTS (
              SELECT 1 FROM match_players x
               WHERE x.match_id = mp.match_id
                 AND x.user_id  = ${callerId}
            )
          RETURNING mp.match_id`,
    );

    // Reassign submissions. No unique constraint on (match_id, user_id) so
    // a plain UPDATE is safe.
    const subRows = await tx.execute<{ id: string }>(
      sql`UPDATE submissions
          SET user_id = ${callerId}
          WHERE user_id = ${target.id}
          RETURNING id`,
    );

    // Reassign votes only where the caller hasn't already voted on the same
    // (match, submission) pair. PK = (match_id, voter_id, submission_id).
    const voteRows = await tx.execute<{ match_id: string }>(
      sql`UPDATE votes v
          SET voter_id = ${callerId}
          WHERE v.voter_id = ${target.id}
            AND NOT EXISTS (
              SELECT 1 FROM votes x
               WHERE x.match_id      = v.match_id
                 AND x.voter_id      = ${callerId}
                 AND x.submission_id = v.submission_id
            )
          RETURNING v.match_id`,
    );

    // Delete the guest user - cascades any remaining collision rows that
    // couldn't be merged (the NOT EXISTS branches above left them on guest).
    await tx.delete(users).where(eq(users.id, target.id));

    // Update the caller's handle to the guest's handle. The guest row is
    // already gone so the unique constraint is satisfied.
    await tx
      .update(users)
      .set({ handle: normalised, updatedAt: new Date() })
      .where(eq(users.id, callerId));

    return {
      matchesMerged: mpRows.length,
      submissionsMerged: subRows.length,
      votesMerged: voteRows.length,
    };
  });

  return c.json(
    {
      newHandle: normalised,
      stats: { matchesMerged, submissionsMerged, votesMerged },
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
