// Tests for requireMatchQuota middleware.
//
// All Redis calls are mocked - no live Redis required.
// The test app wires anonId middleware manually so we exercise the real
// middleware chain without importing auth code.

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock ioredis before any module under test is imported ───────────────────

const mockIncr = vi.fn<() => Promise<number>>();
const mockExpire = vi.fn<() => Promise<number>>();
const mockTtl = vi.fn<() => Promise<number>>();
const mockOn = vi.fn();

vi.mock('ioredis', () => {
  const MockRedis = vi.fn(() => ({
    incr: mockIncr,
    expire: mockExpire,
    ttl: mockTtl,
    on: mockOn,
  }));
  return { default: MockRedis };
});

// ─── Import modules under test AFTER mock is in place ────────────────────────

// eslint-disable-next-line import/order
import {
  ANON_MATCH_LIMIT,
  _resetClientForTest,
  requireMatchQuota,
  requireProducerQuota,
} from './rate-limit.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FAKE_ANON_ID = 'test-anon-uuid-1234';
const FAKE_USER = {
  id: 'user-abc',
  email: 'test@example.com',
  handle: 'test',
  role: 'producer' as const,
  plan: 'free' as const,
};

// Additional user fixtures for producer-quota tests.
const FREE_PRODUCER = {
  id: 'free-user-1',
  email: 'free@example.com',
  handle: 'free',
  role: 'producer' as const,
  plan: 'free' as const,
};
const PAID_PRODUCER = {
  id: 'paid-user-1',
  email: 'paid@example.com',
  handle: 'paid',
  role: 'producer' as const,
  plan: 'paid' as const,
};
const ADMIN_USER = {
  id: 'admin-1',
  email: 'admin@example.com',
  handle: 'admin',
  role: 'admin' as const,
  plan: 'free' as const,
};
const AR_USER = {
  id: 'ar-1',
  email: 'ar@example.com',
  handle: 'ar',
  role: 'ar' as const,
  plan: 'free' as const,
};

/**
 * Build a minimal Hono app that:
 *  - optionally sets c.var.user (to simulate authenticated request)
 *  - always sets c.var.anonId to FAKE_ANON_ID
 *  - applies requireMatchQuota
 *  - returns 201 on the happy path
 */
function buildApp(opts: { authenticated?: boolean } = {}) {
  const app = new Hono();

  // Simulate session / anon-id middleware.
  app.use('*', async (c, next) => {
    if (opts.authenticated) {
      c.set('user', FAKE_USER);
    }
    c.set('anonId', FAKE_ANON_ID);
    await next();
  });

  app.post('/matches', requireMatchQuota(), (c) => c.json({ ok: true }, 201));

  return app;
}

async function postMatch(app: Hono) {
  return app.request('/matches', { method: 'POST' });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('requireMatchQuota', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset lazy client so each test starts with a fresh mock instance.
    _resetClientForTest();
    // Default TTL returned when key exists.
    mockTtl.mockResolvedValue(86_000);
  });

  describe('anonymous visitor', () => {
    it('allows the first three requests and blocks the fourth with 429', async () => {
      const app = buildApp();

      // First 3 requests succeed.
      for (let call = 1; call <= 3; call++) {
        mockIncr.mockResolvedValueOnce(call);
        const res = await postMatch(app);
        expect(res.status, `request #${call} should be 201`).toBe(201);
      }

      // Fourth request exceeds ANON_MATCH_LIMIT (3).
      mockIncr.mockResolvedValueOnce(4);
      mockTtl.mockResolvedValueOnce(82_000);
      const res = await postMatch(app);

      expect(res.status).toBe(429);

      const body = (await res.json()) as {
        error: string;
        retryAfterSeconds: number;
      };
      expect(body.error).toBe('free_tier_limit');
      expect(body.retryAfterSeconds).toBe(82_000);
      expect(res.headers.get('Retry-After')).toBe('82000');
    });

    it('sets EXPIRE on the key only when count === 1 (first request)', async () => {
      const app = buildApp();

      mockIncr.mockResolvedValueOnce(1);
      await postMatch(app);
      expect(mockExpire).toHaveBeenCalledOnce();
      expect(mockExpire).toHaveBeenCalledWith(`rl:match:create:${FAKE_ANON_ID}`, 86_400);

      // Second request - EXPIRE must NOT be called again.
      mockIncr.mockResolvedValueOnce(2);
      await postMatch(app);
      expect(mockExpire).toHaveBeenCalledOnce(); // still once total
    });

    it('returns 429 with a JSON body matching the spec', async () => {
      const app = buildApp();
      mockIncr.mockResolvedValueOnce(ANON_MATCH_LIMIT + 1);
      mockTtl.mockResolvedValueOnce(3600);

      const res = await postMatch(app);
      expect(res.status).toBe(429);

      const body = await res.json();
      expect(body).toMatchObject({
        error: 'free_tier_limit',
        message: expect.stringContaining('Sign up'),
        retryAfterSeconds: 3600,
      });
    });
  });

  describe('authenticated request', () => {
    it('bypasses the quota entirely - Redis is never touched', async () => {
      const app = buildApp({ authenticated: true });

      // Even if Redis would return a very high count, auth bypasses it.
      const res = await postMatch(app);

      expect(res.status).toBe(201);
      expect(mockIncr).not.toHaveBeenCalled();
      expect(mockExpire).not.toHaveBeenCalled();
    });
  });

  describe('Redis outage (fail-open)', () => {
    it('passes the request through when redis.incr throws', async () => {
      const app = buildApp();
      mockIncr.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const res = await postMatch(app);

      // Request should succeed even though Redis is down.
      expect(res.status).toBe(201);
    });
  });
});

// ─── requireProducerQuota ─────────────────────────────────────────────────────

describe('requireProducerQuota', () => {
  // Build a minimal Hono app that optionally sets c.var.user and applies
  // requireProducerQuota for 'match'. Returns 201 on the happy path.
  function buildProducerApp(
    user:
      | typeof FREE_PRODUCER
      | typeof PAID_PRODUCER
      | typeof ADMIN_USER
      | typeof AR_USER
      | null = null,
  ) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (user) c.set('user', user);
      await next();
    });
    app.post('/matches', requireProducerQuota('match'), (c) => c.json({ ok: true }, 201));
    return app;
  }

  async function postToMatches(app: Hono) {
    return app.request('/matches', { method: 'POST' });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetClientForTest();
    mockTtl.mockResolvedValue(86_000);
  });

  it('free producer under limit passes through (returns 201)', async () => {
    const app = buildProducerApp(FREE_PRODUCER);
    mockIncr.mockResolvedValueOnce(1);
    const res = await postToMatches(app);
    expect(res.status).toBe(201);
  });

  it('free producer at exactly max (count === max) passes through', async () => {
    const app = buildProducerApp(FREE_PRODUCER);
    // max for 'match' on free plan is 20
    mockIncr.mockResolvedValueOnce(20);
    const res = await postToMatches(app);
    expect(res.status).toBe(201);
  });

  it('free producer at max+1 returns 429 with correct body and headers', async () => {
    const app = buildProducerApp(FREE_PRODUCER);
    // count 21 exceeds the free plan match limit of 20
    mockIncr.mockResolvedValueOnce(21);
    mockTtl.mockResolvedValueOnce(3_600);
    const res = await postToMatches(app);

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');

    const body = (await res.json()) as {
      error: string;
      limitKind: string;
      retryAfterSeconds: number;
    };
    expect(body.error).toBe('producer_quota_exceeded');
    expect(body.limitKind).toBe('match');
    expect(body.retryAfterSeconds).toBe(3_600);
  });

  it('paid producer uses the 5x limit (100 for match) - count 100 still passes', async () => {
    const app = buildProducerApp(PAID_PRODUCER);
    // max for 'match' on paid plan is 100; count 100 should pass
    mockIncr.mockResolvedValueOnce(100);
    const res = await postToMatches(app);
    expect(res.status).toBe(201);
  });

  it('paid producer at 101 returns 429', async () => {
    const app = buildProducerApp(PAID_PRODUCER);
    mockIncr.mockResolvedValueOnce(101);
    mockTtl.mockResolvedValueOnce(7_200);
    const res = await postToMatches(app);
    expect(res.status).toBe(429);
  });

  it('admin bypasses quota regardless of count - Redis never touched', async () => {
    const app = buildProducerApp(ADMIN_USER);
    const res = await postToMatches(app);
    expect(res.status).toBe(201);
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it('A&R bypasses quota regardless of count - Redis never touched', async () => {
    const app = buildProducerApp(AR_USER);
    const res = await postToMatches(app);
    expect(res.status).toBe(201);
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it('anonymous request (no user) passes through without touching Redis', async () => {
    const app = buildProducerApp(null);
    const res = await postToMatches(app);
    expect(res.status).toBe(201);
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it('fails open when Redis is unavailable (incr throws)', async () => {
    const app = buildProducerApp(FREE_PRODUCER);
    mockIncr.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await postToMatches(app);
    expect(res.status).toBe(201);
  });
});
