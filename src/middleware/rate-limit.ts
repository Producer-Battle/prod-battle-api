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
// key migrations are needed — the new limit applies to keys created after the
// deploy; existing keys expire within 24 h at most.

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
      // anonId middleware not wired — fail-open so we don't block valid traffic.
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
        // First request in window — set TTL so the key self-expires after 24 h.
        await redis.expire(key, 86_400);
      }
    } catch (err) {
      // Redis unavailable — fail-open.
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
        // ignore — fallback value is already set
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
