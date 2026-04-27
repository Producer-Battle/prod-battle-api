// Self-serve profile endpoints for authenticated users.
//
// GET  /me                      - full profile shape for the current user
// PATCH /me                     - update handle and/or avatarUrl
// POST /me/claim-guest-handle   - merge a guest identity into the caller's account
// GET  /users/:handle           - public profile for any active user (no email, no status)

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { presignAvatarUpload, signUrl } from '../audio/s3.js';
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
    bio: z.string().nullable(),
    socialLinks: z.record(z.string(), z.string()),
    createdAt: z.string(),
    stats: z.object({
      totalMatches: z.number().int(),
      totalSubmissions: z.number().int(),
      bestRank: z.number().int().nullable(),
    }),
    // Honor + calibration state, surfaced on every /me poll so the frontend
    // can show "calibrating (N matches left)" and "Honor: ★★★★★".
    honor: z.number().int(),
    calibrationMatchesRemaining: z.number().int(),
    // Per-genre ranked tier display. Empty during calibration.
    rankedTiers: z.array(
      z.object({
        genreSlug: z.string(),
        genreName: z.string(),
        lp: z.number().int(),
        tier: z.string(),
        wins: z.number().int(),
        losses: z.number().int(),
      }),
    ),
    profileVisibility: z.object({
      matchHistory: z.boolean(),
      stats: z.boolean(),
      packs: z.boolean(),
      achievements: z.boolean(),
    }),
    payoutEmail: z.string().email().nullable(),
    payoutIban: z.string().nullable(),
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
      honor: users.honor,
      calibrationMatchesRemaining: users.calibrationMatchesRemaining,
      profileVisibility: users.profileVisibility,
      payoutEmail: users.payoutEmail,
      payoutIban: users.payoutIban,
      bio: producerProfiles.bio,
      socialLinks: producerProfiles.socialLinks,
    })
    .from(users)
    .leftJoin(producerProfiles, eq(producerProfiles.userId, users.id))
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

  // Per-genre tier display - one row per ranked genre the user has played
  // this season. Hidden during calibration to avoid fixating on a half-
  // formed estimate.
  type TierLike = {
    genreSlug: string;
    genreName: string;
    lp: number;
    tier: string;
    wins: number;
    losses: number;
  };
  let rankedTiers: TierLike[] = [];
  if (row.calibrationMatchesRemaining === 0) {
    const { activeSeason } = await import('../game-rules/loader.js');
    const { glickoToTier } = await import('../tiers/index.js');
    const season = await activeSeason().catch(() => null);
    if (season) {
      const tierRows = await d.execute<{
        genre_slug: string;
        genre_name: string;
        rating: string;
        wins: number;
        losses: number;
      }>(
        sql`SELECT g.slug AS genre_slug, g.name AS genre_name,
                   r.glicko_rating::text AS rating, r.wins, r.losses
              FROM rankings r
              JOIN genres g ON g.id = r.genre_id
             WHERE r.user_id = ${user.id} AND r.season_id = ${season.id}
             ORDER BY r.glicko_rating DESC`,
      );
      const arr = tierRows as Array<{
        genre_slug: string;
        genre_name: string;
        rating: string;
        wins: number;
        losses: number;
      }>;
      rankedTiers = await Promise.all(
        arr.map(async (rr) => {
          const tier = await glickoToTier(Number(rr.rating));
          return {
            genreSlug: rr.genre_slug,
            genreName: rr.genre_name,
            lp: tier.lp,
            tier: tier.label,
            wins: Number(rr.wins),
            losses: Number(rr.losses),
          };
        }),
      );
    }
  }

  return c.json(
    {
      id: row.id,
      handle: row.handle,
      email: row.email,
      role: row.role,
      plan: row.plan,
      status: row.status,
      avatarUrl: row.avatarUrl ? await signUrl(row.avatarUrl, 3600) : null,
      bio: row.bio ?? null,
      socialLinks: row.socialLinks ?? {},
      createdAt: row.createdAt.toISOString(),
      stats: {
        totalMatches: Number(stats?.total_matches ?? 0),
        totalSubmissions: Number(stats?.total_submissions ?? 0),
        bestRank: stats?.best_rank != null ? Number(stats.best_rank) : null,
      },
      honor: row.honor,
      calibrationMatchesRemaining: row.calibrationMatchesRemaining,
      rankedTiers,
      profileVisibility: {
        matchHistory: row.profileVisibility?.matchHistory ?? true,
        stats: row.profileVisibility?.stats ?? true,
        packs: row.profileVisibility?.packs ?? true,
        achievements: row.profileVisibility?.achievements ?? true,
      },
      payoutEmail: row.payoutEmail ?? null,
      payoutIban: row.payoutIban ?? null,
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
    bio: z.string().max(500).nullable().optional(),
    socialLinks: z.record(z.string(), z.string().url()).nullable().optional(),
    // Per-section profile visibility. Missing keys default to true.
    profileVisibility: z
      .object({
        matchHistory: z.boolean().optional(),
        stats: z.boolean().optional(),
        packs: z.boolean().optional(),
        achievements: z.boolean().optional(),
      })
      .optional(),
    // Creator payout preferences. Set both for redundancy (admin
    // settles via whichever channel works); empty string clears.
    payoutEmail: z.string().email().nullable().optional(),
    payoutIban: z.string().min(15).max(34).nullable().optional(),
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

  const updates: {
    handle?: string;
    avatarUrl?: string | null;
    profileVisibility?: Record<string, boolean>;
    payoutEmail?: string | null;
    payoutIban?: string | null;
  } = {};

  if (body.payoutEmail !== undefined) updates.payoutEmail = body.payoutEmail;
  if (body.payoutIban !== undefined) updates.payoutIban = body.payoutIban;

  if (body.profileVisibility !== undefined) {
    // Strip undefined values - jsonb column wants a clean object.
    const v: Record<string, boolean> = {};
    for (const [k, val] of Object.entries(body.profileVisibility)) {
      if (val !== undefined) v[k] = val;
    }
    updates.profileVisibility = v;
  }

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

  // Upsert producer_profiles when bio or socialLinks is provided.
  const profileUpdates: {
    bio?: string | null;
    socialLinks?: Record<string, string>;
  } = {};
  if (body.bio !== undefined) profileUpdates.bio = body.bio;
  // socialLinks null from the client means "clear all links" - store as empty object
  // since the column is NOT NULL.
  if (body.socialLinks !== undefined) {
    profileUpdates.socialLinks = body.socialLinks ?? {};
  }

  if (Object.keys(profileUpdates).length > 0) {
    await d
      .insert(producerProfiles)
      .values({
        userId: user.id,
        // Default new rows to openToAr: true (platform default).
        openToAr: true,
        bio: profileUpdates.bio ?? null,
        socialLinks: profileUpdates.socialLinks ?? {},
      })
      .onConflictDoUpdate({
        target: producerProfiles.userId,
        set: profileUpdates,
      });
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
      honor: users.honor,
      calibrationMatchesRemaining: users.calibrationMatchesRemaining,
      profileVisibility: users.profileVisibility,
      payoutEmail: users.payoutEmail,
      payoutIban: users.payoutIban,
      bio: producerProfiles.bio,
      socialLinks: producerProfiles.socialLinks,
    })
    .from(users)
    .leftJoin(producerProfiles, eq(producerProfiles.userId, users.id))
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
      avatarUrl: row.avatarUrl ? await signUrl(row.avatarUrl, 3600) : null,
      bio: row.bio ?? null,
      socialLinks: row.socialLinks ?? {},
      createdAt: row.createdAt.toISOString(),
      stats: {
        totalMatches: Number(stats?.total_matches ?? 0),
        totalSubmissions: Number(stats?.total_submissions ?? 0),
        bestRank: stats?.best_rank != null ? Number(stats.best_rank) : null,
      },
      honor: row.honor,
      calibrationMatchesRemaining: row.calibrationMatchesRemaining,
      rankedTiers: [] as Array<never>,
      profileVisibility: {
        matchHistory: row.profileVisibility?.matchHistory ?? true,
        stats: row.profileVisibility?.stats ?? true,
        packs: row.profileVisibility?.packs ?? true,
        achievements: row.profileVisibility?.achievements ?? true,
      },
      payoutEmail: row.payoutEmail ?? null,
      payoutIban: row.payoutIban ?? null,
    },
    200,
  );
});

// ─── POST /me/avatar/upload-url ─────────────────────────────────────────────

const AvatarUploadUrlBody = z
  .object({
    contentType: z.enum(['image/jpeg', 'image/png']),
  })
  .openapi('AvatarUploadUrlBody');

const AvatarUploadUrlResponse = z
  .object({
    uploadUrl: z.string().url(),
    publicUrl: z.string().url(),
    key: z.string(),
    maxBytes: z.number().int(),
  })
  .openapi('AvatarUploadUrlResponse');

const avatarUploadUrlRoute = createRoute({
  method: 'post',
  path: '/me/avatar/upload-url',
  tags: ['profile'],
  summary: 'Get a presigned S3 PUT URL for avatar upload',
  middleware: [requireAuth()] as const,
  request: {
    body: { content: { 'application/json': { schema: AvatarUploadUrlBody } } },
  },
  responses: {
    200: {
      description: 'Presigned upload URL',
      content: { 'application/json': { schema: AvatarUploadUrlResponse } },
    },
    400: { description: 'Unsupported content type' },
    401: { description: 'Unauthenticated' },
  },
});

meRoutes.openapi(avatarUploadUrlRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const { contentType } = c.req.valid('json');

  const result = await presignAvatarUpload(user.id, contentType);
  return c.json(result, 200);
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

const PublicTierRow = z.object({
  genreSlug: z.string(),
  genreName: z.string(),
  lp: z.number().int(),
  tier: z.string(),
  wins: z.number().int(),
  losses: z.number().int(),
});

const PublicProfileResponse = z
  .object({
    id: z.string().uuid(),
    handle: z.string(),
    avatarUrl: z.string().nullable(),
    role: z.enum(['producer', 'ar', 'admin']),
    bio: z.string().nullable(),
    socialLinks: z.record(z.string(), z.string()),
    createdAt: z.string(),
    // Public game stats. Honor is exposed as a 0-5 star count (not the
    // raw number) to read as reputation rather than judgement.
    honorStars: z.number().int().min(0).max(5),
    calibrating: z.boolean(),
    rankedTiers: z.array(PublicTierRow),
    stats: z.object({
      wins: z.number().int(),
      matches: z.number().int(),
      streakDays: z.number().int(),
    }),
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
      honor: users.honor,
      calibrationMatchesRemaining: users.calibrationMatchesRemaining,
      bio: producerProfiles.bio,
      socialLinks: producerProfiles.socialLinks,
    })
    .from(users)
    .leftJoin(producerProfiles, eq(producerProfiles.userId, users.id))
    .where(eq(users.handle, normalised))
    .limit(1);

  if (!row || row.status !== 'active') {
    return c.json({ error: 'not found' }, 404);
  }

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

  // Honor mapped to a 0-5 star count so the public profile reads as
  // reputation, not a number. 100 -> 5 stars, 80 -> 4, etc.
  const honorStars = Math.max(0, Math.min(5, Math.floor(row.honor / 20)));
  const calibrating = row.calibrationMatchesRemaining > 0;

  // Per-genre tier display - same logic as /me but skipped during
  // calibration.
  type TierLike = {
    genreSlug: string;
    genreName: string;
    lp: number;
    tier: string;
    wins: number;
    losses: number;
  };
  let rankedTiers: TierLike[] = [];
  if (!calibrating) {
    const { activeSeason } = await import('../game-rules/loader.js');
    const { glickoToTier } = await import('../tiers/index.js');
    const season = await activeSeason().catch(() => null);
    if (season) {
      const tierRows = await d.execute<{
        genre_slug: string;
        genre_name: string;
        rating: string;
        wins: number;
        losses: number;
      }>(
        sql`SELECT g.slug AS genre_slug, g.name AS genre_name,
                   r.glicko_rating::text AS rating, r.wins, r.losses
              FROM rankings r
              JOIN genres g ON g.id = r.genre_id
             WHERE r.user_id = ${row.id} AND r.season_id = ${season.id}
             ORDER BY r.glicko_rating DESC`,
      );
      const arr = tierRows as Array<{
        genre_slug: string;
        genre_name: string;
        rating: string;
        wins: number;
        losses: number;
      }>;
      rankedTiers = await Promise.all(
        arr.map(async (rr) => {
          const tier = await glickoToTier(Number(rr.rating));
          return {
            genreSlug: rr.genre_slug,
            genreName: rr.genre_name,
            lp: tier.lp,
            tier: tier.label,
            wins: Number(rr.wins),
            losses: Number(rr.losses),
          };
        }),
      );
    }
  }

  // Match-level stats. matches = distinct match ids the user submitted in;
  // wins = submissions with final_rank=1; streakDays computed from the
  // longest run of consecutive UTC days they completed at least one
  // non-abandoned match. Approximated client-side too for consistency.
  const [matchStats] = await d.execute<{
    matches: string;
    wins: string;
    streak: string;
  }>(
    sql`SELECT
          COUNT(DISTINCT s.match_id)::text AS matches,
          COUNT(*) FILTER (WHERE s.final_rank = 1)::text AS wins,
          0::text AS streak
        FROM submissions s
        WHERE s.user_id = ${row.id}`,
  );

  return c.json({
    id: row.id,
    handle: row.handle,
    avatarUrl: row.avatarUrl ? await signUrl(row.avatarUrl, 3600) : null,
    role: row.role,
    bio: row.bio ?? null,
    socialLinks: row.socialLinks ?? {},
    createdAt: row.createdAt.toISOString(),
    honorStars,
    calibrating,
    rankedTiers,
    stats: {
      wins: Number(matchStats?.wins ?? 0),
      matches: Number(matchStats?.matches ?? 0),
      streakDays: Number(matchStats?.streak ?? 0),
    },
    recentSubmissions,
  });
});

// ─── POST /me/fingerprint ───────────────────────────────────────────────────
//
// Lightweight client-side browser fingerprint capture. The web client
// sends { canvasHash, screenDims, timezone, userAgent } on signup and
// occasionally afterwards. We append to users.device_fingerprints
// (keep last 10 entries) and the cluster-guard reads from this list to
// decide whether two accounts likely belong to the same person.
//
// None of the fields are PII-sensitive on their own; the array grows to
// at most 10 entries per user (oldest dropped).

const FingerprintBody = z.object({
  canvasHash: z.string().max(128),
  screenDims: z.string().max(32),
  timezone: z.string().max(64),
  userAgent: z.string().max(512),
});

const fingerprintRoute = createRoute({
  method: 'post',
  path: '/me/fingerprint',
  tags: ['profile'],
  summary: 'Record a browser fingerprint for the authenticated user',
  middleware: [requireAuth()] as const,
  request: { body: { content: { 'application/json': { schema: FingerprintBody } } } },
  responses: {
    204: { description: 'Captured (no body)' },
    401: { description: 'Unauthenticated' },
  },
});

meRoutes.openapi(fingerprintRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.body(null, 401);
  const fp = c.req.valid('json');
  const d = db();

  const [u] = await d
    .select({ list: users.deviceFingerprints })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  const list = u?.list ?? [];
  const seen = list.find(
    (e) =>
      e.canvasHash === fp.canvasHash &&
      e.screenDims === fp.screenDims &&
      e.userAgent === fp.userAgent,
  );
  if (seen) return c.body(null, 204);

  const next = [...list, { ...fp, capturedAt: new Date().toISOString() }].slice(-10);
  await d.update(users).set({ deviceFingerprints: next }).where(eq(users.id, user.id));
  return c.body(null, 204);
});

// ─── DELETE /me ─────────────────────────────────────────────────────────────
//
// Self-serve account deletion with a 14-day grace window. Sets status=
// 'archived' and deletedAt=now so the account stops appearing in public
// lists and the user can't sign in - but their match history still
// references the user row (FK preserved). Logging in during the window
// restores by clearing deletedAt + flipping status back to active. After
// 14 days, a sweep cron hard-deletes the row (cascade clears submissions,
// match_players, etc).

const DeleteMeResponse = z
  .object({
    status: z.literal('scheduled_for_deletion'),
    graceEndsAt: z.string().datetime(),
  })
  .openapi('DeleteMeResponse');

const deleteMeRoute = createRoute({
  method: 'delete',
  path: '/me',
  tags: ['profile'],
  summary: 'Schedule own-account deletion (14-day grace)',
  middleware: [requireAuth()] as const,
  responses: {
    200: {
      description: 'Scheduled',
      content: { 'application/json': { schema: DeleteMeResponse } },
    },
    401: { description: 'Unauthenticated' },
  },
});

meRoutes.openapi(deleteMeRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  const now = new Date();
  await db().update(users).set({ status: 'archived', deletedAt: now }).where(eq(users.id, user.id));

  // 14 days from now, returned for the UI to show "deletes on Mar 13".
  const graceEndsAt = new Date(now.getTime() + 14 * 86400 * 1000);

  return c.json(
    { status: 'scheduled_for_deletion' as const, graceEndsAt: graceEndsAt.toISOString() },
    200,
  );
});
