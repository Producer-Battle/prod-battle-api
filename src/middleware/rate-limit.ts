// Middleware: anonymous match-creation rate limit.
//
// Enforces a daily quota of ANON_MATCH_LIMIT match creations per anonymous
// visitor (identified by the `pb_anon` cookie set by anon-id.ts).
// Authenticated requests (c.var.user is truthy) bypass the limit entirely.
//
// Redis key:  rl:match:create:<anonId>
// TTL:        86 400 seconds (24 h rolling from first request)
//
// Fail-open: if Redis is unavailable the request is allowed through and a
// warning is logged. This keeps the API healthy during Redis restarts.
//
// To raise the limit, change ANON_MATCH_LIMIT below and redeploy. No Redis
// key migrations are needed - the new limit applies to keys created after the
// deploy; existing keys expire within 24 h at most.

import { createHash } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import Redis from 'ioredis';
import { env } from '../env.js';

// ─── Lazy Redis client ────────────────────────────────────────────────────────

let _client: Redis | null = null;

function getRedisClient(): Redis {
  if (!_client) {
    const url = env.REDIS_URL ?? 'redis://localhost:6379';
    _client = new Redis(url, {
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      maxRetriesPerRequest: 1,
    });
    _client.on('error', (err: Error) => {
      console.warn('[rate-limit] redis error:', err.message);
    });
  }
  return _client;
}

// ─── Quota constant ───────────────────────────────────────────────────────────

/**
 * Maximum number of matches an anonymous visitor may create per 24-hour
 * window. Raise this value and redeploy to relax the limit.
 */
export const ANON_MATCH_LIMIT = 3;

// `c.var.user` is declared by src/middleware/session.ts. We just consume
// it here as a truthy-check, so we don't need our own ContextVariableMap
// augmentation.

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Apply to POST /matches. Authenticated users pass through unconditionally.
 * Anonymous visitors are limited to ANON_MATCH_LIMIT creations per day.
 */
export function requireMatchQuota() {
  return createMiddleware(async (c, next) => {
    // Authenticated users are never rate-limited.
    if (c.var.user) {
      await next();
      return;
    }

    const anonId: string | undefined = c.var.anonId;
    if (!anonId) {
      // anonId middleware not wired - fail-open so we don't block valid traffic.
      console.warn('[rate-limit] anonId not set; skipping quota check');
      await next();
      return;
    }

    const key = `rl:match:create:${anonId}`;
    let count: number;

    try {
      const redis = getRedisClient();
      count = await redis.incr(key);
      if (count === 1) {
        // First request in window - set TTL so the key self-expires after 24 h.
        await redis.expire(key, 86_400);
      }
    } catch (err) {
      // Redis unavailable - fail-open.
      console.warn(
        '[rate-limit] redis unavailable, passing request through:',
        (err as Error).message,
      );
      await next();
      return;
    }

    if (count > ANON_MATCH_LIMIT) {
      // Fetch remaining TTL for the Retry-After header.
      let retryAfterSeconds = 86_400; // safe fallback
      try {
        const redis = getRedisClient();
        const ttl = await redis.ttl(key);
        if (ttl > 0) retryAfterSeconds = ttl;
      } catch {
        // ignore - fallback value is already set
      }

      c.header('Retry-After', String(retryAfterSeconds));
      return c.json(
        {
          error: 'free_tier_limit',
          message: 'Free tier is 3 matches per day. Sign up (free) for unlimited.',
          retryAfterSeconds,
        },
        429,
      );
    }

    await next();
  });
}

// Exported for tests that need to reset module-level state between cases.
export function _resetClientForTest(): void {
  _client = null;
}

// ─── Per-producer daily quotas ────────────────────────────────────────────────

type ProducerQuotaKind = 'match' | 'sub' | 'pack' | 'genre';

const PRODUCER_LIMITS_FREE: Record<ProducerQuotaKind, { max: number; ttl: number }> = {
  match: { max: 20, ttl: 86_400 },
  sub: { max: 32, ttl: 86_400 },
  pack: { max: 5, ttl: 86_400 },
  genre: { max: 1, ttl: 604_800 },
};

const PRODUCER_LIMITS_PAID: Record<ProducerQuotaKind, { max: number; ttl: number }> = {
  match: { max: 100, ttl: 86_400 },
  sub: { max: 160, ttl: 86_400 },
  pack: { max: 25, ttl: 86_400 },
  genre: { max: 5, ttl: 604_800 },
};

/**
 * Apply to mutation endpoints to enforce per-user daily limits for
 * authenticated producers. Admin and A&R roles bypass unconditionally.
 * Unauthenticated requests pass through (handled by requireMatchQuota/anon
 * middleware). Fails open when Redis is unavailable.
 */
export function requireProducerQuota(kind: ProducerQuotaKind) {
  return createMiddleware(async (c, next) => {
    const user = c.var.user;
    // Unauthenticated: this middleware is producer-specific; anon middleware
    // handles the anonymous path.
    if (!user) {
      await next();
      return;
    }
    // Admin + A&R bypass all producer quotas.
    if (user.role === 'admin' || user.role === 'ar') {
      await next();
      return;
    }

    const table = user.plan === 'paid' ? PRODUCER_LIMITS_PAID : PRODUCER_LIMITS_FREE;
    const { max, ttl } = table[kind];
    const key = `rl:producer:${kind}:${user.id}`;
    let count = 0;

    try {
      const redis = getRedisClient();
      count = await redis.incr(key);
      if (count === 1) await redis.expire(key, ttl);
    } catch (err) {
      console.warn('[rate-limit] producer redis unavailable:', (err as Error).message);
      await next();
      return;
    }

    if (count > max) {
      let retryAfterSeconds = ttl;
      try {
        const redis = getRedisClient();
        const t = await redis.ttl(key);
        if (t > 0) retryAfterSeconds = t;
      } catch {
        /* ignore - fallback value already set */
      }

      c.header('Retry-After', String(retryAfterSeconds));
      return c.json(
        {
          error: 'producer_quota_exceeded',
          message: `Daily ${kind} limit reached. Upgrade to Pro for higher limits, or try again in ${Math.ceil(retryAfterSeconds / 3600)}h.`,
          retryAfterSeconds,
          limitKind: kind,
        },
        429,
      );
    }

    await next();
  });
}

// ─── Sign-up rate-limit ───────────────────────────────────────────────────────
//
// Guards /auth/sign-up/email (and OAuth sign-up paths) against account-farm
// bots. Two independent limits enforced in parallel:
//
//   - Per device fingerprint (X-Pb-Fp header, SHA-256 hashed):
//       signup:fp:<sha256>  INCR / EXPIRE 86400  - max 3 per day
//   - Per IP (/24 bucket, SHA-256 hashed - looser to accommodate NAT):
//       signup:ip:<sha256>  INCR / EXPIRE 86400  - max 10 per day
//
// If the X-Pb-Fp header is absent (older clients, native apps, etc.) only
// the IP check fires. Either limit can reject with 429.
//
// Fail-open: Redis errors are logged and the request is let through so a
// Redis restart never hard-blocks legitimate signups.
//
// Web-side integration note: the web client should send the thumbmark hash
// in the X-Pb-Fp header on the sign-up request. In
// web/src/lib/auth.ts signUpEmail, add:
//   headers: { 'x-pb-fp': await deviceId() }

export const SIGNUP_FP_LIMIT = 3;
export const SIGNUP_IP_LIMIT = 10;

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Extract a best-effort /24 IP bucket from a raw IP string.
 * Returns the full IP if parsing fails (safe fallback - a tighter bucket).
 */
function ipBucket(rawIp: string): string {
  // Strip IPv6 brackets / port suffixes.
  const clean = rawIp.replace(/^\[|\]?(:\d+)?$/g, '').trim();
  const m4 = clean.match(/^(\d+\.\d+\.\d+)\.\d+$/);
  if (m4) return `${m4[1]}.0/24`;
  // For IPv6 keep the full address (each /48 is already one org typically).
  return clean;
}

/**
 * Apply to the sign-up route(s) to rate-limit account creation by device
 * fingerprint and source IP. Fail-open on Redis errors.
 */
export function requireSignupQuota() {
  return createMiddleware(async (c, next) => {
    const fpHeader = c.req.header('x-pb-fp');
    const rawIp =
      c.req.header('cf-connecting-ip') ??
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip') ??
      '';

    try {
      const redis = getRedisClient();

      // Per-device fingerprint check (optional - skip if header absent).
      if (fpHeader && fpHeader.trim().length > 0) {
        const fpKey = `signup:fp:${sha256hex(fpHeader.trim())}`;
        const fpCount = await redis.incr(fpKey);
        if (fpCount === 1) await redis.expire(fpKey, 86_400);
        if (fpCount > SIGNUP_FP_LIMIT) {
          return c.json(
            {
              error: 'too_many_signups',
              message: 'Too many sign-ups from this device or network. Try again in 24h.',
            },
            429,
          );
        }
      }

      // Per-IP check (always fires when IP is available).
      if (rawIp.length > 0) {
        const ipKey = `signup:ip:${sha256hex(ipBucket(rawIp))}`;
        const ipCount = await redis.incr(ipKey);
        if (ipCount === 1) await redis.expire(ipKey, 86_400);
        if (ipCount > SIGNUP_IP_LIMIT) {
          return c.json(
            {
              error: 'too_many_signups',
              message: 'Too many sign-ups from this device or network. Try again in 24h.',
            },
            429,
          );
        }
      }
    } catch (err) {
      // Redis unavailable - fail-open.
      console.warn(
        '[signup-rl] redis unavailable, skipping signup rate limit:',
        (err as Error).message,
      );
    }

    await next();
  });
}

// Re-export the client reset for signup rate-limit tests.
export const _resetSignupRlForTest = _resetClientForTest;
