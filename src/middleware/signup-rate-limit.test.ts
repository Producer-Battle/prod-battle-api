// Tests for requireSignupQuota middleware.
//
// All Redis calls are mocked - no live Redis required.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock ioredis before any module under test is imported ───────────────────

const mockIncr = vi.fn<() => Promise<number>>();
const mockExpire = vi.fn<() => Promise<number>>();
const mockOn = vi.fn();

vi.mock('ioredis', () => {
  const MockRedis = vi.fn(() => ({
    incr: mockIncr,
    expire: mockExpire,
    on: mockOn,
  }));
  return { default: MockRedis };
});

// ─── Import modules under test AFTER mock is in place ────────────────────────

// eslint-disable-next-line import/order
import {
  SIGNUP_FP_LIMIT,
  SIGNUP_IP_LIMIT,
  _resetSignupRlForTest,
  requireSignupQuota,
} from './rate-limit.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FAKE_FP = 'abc123fingerprint';
const FAKE_IP = '203.0.113.42';

function buildApp() {
  const app = new Hono();
  app.post('/auth/sign-up/email', requireSignupQuota(), (c) => c.json({ ok: true }, 200));
  return app;
}

async function postSignup(
  app: Hono,
  opts: { fp?: string; ip?: string; forwardedFor?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.fp) headers['x-pb-fp'] = opts.fp;
  if (opts.ip) headers['cf-connecting-ip'] = opts.ip;
  if (opts.forwardedFor) headers['x-forwarded-for'] = opts.forwardedFor;
  return app.request('/auth/sign-up/email', { method: 'POST', headers });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('requireSignupQuota', () => {
  beforeEach(() => {
    // mockReset clears both call history AND any queued once-values from
    // previous tests so they don't bleed across test boundaries.
    mockIncr.mockReset();
    mockExpire.mockReset();
    _resetSignupRlForTest();
  });

  describe('fingerprint limit', () => {
    it('allows signups under the per-device limit', async () => {
      const app = buildApp();
      // FP check + IP check each return 1 (first call in window)
      mockIncr
        .mockResolvedValueOnce(1) // fp key
        .mockResolvedValueOnce(1); // ip key
      const res = await postSignup(app, { fp: FAKE_FP, ip: FAKE_IP });
      expect(res.status).toBe(200);
    });

    it(`blocks when fp count exceeds ${SIGNUP_FP_LIMIT}`, async () => {
      const app = buildApp();
      // Only the fp incr fires; middleware returns 429 before reaching the ip check.
      mockIncr.mockResolvedValueOnce(SIGNUP_FP_LIMIT + 1);
      const res = await postSignup(app, { fp: FAKE_FP, ip: FAKE_IP });

      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('too_many_signups');
      expect(body.message).toMatch(/24h/);
    });

    it('sets EXPIRE only on first increment (fp key)', async () => {
      const app = buildApp();
      mockIncr
        .mockResolvedValueOnce(1) // fp key - first call
        .mockResolvedValueOnce(1); // ip key - first call
      await postSignup(app, { fp: FAKE_FP, ip: FAKE_IP });
      // Should have called expire for fp key and ip key (both first-time)
      expect(mockExpire).toHaveBeenCalledTimes(2);
      expect(mockExpire).toHaveBeenCalledWith(expect.stringContaining('signup:fp:'), 86_400);
      expect(mockExpire).toHaveBeenCalledWith(expect.stringContaining('signup:ip:'), 86_400);
    });

    it('skips fp check when header is absent', async () => {
      const app = buildApp();
      mockIncr.mockResolvedValueOnce(1); // only ip key
      const res = await postSignup(app, { ip: FAKE_IP });
      expect(res.status).toBe(200);
      // incr called exactly once (ip), not twice
      expect(mockIncr).toHaveBeenCalledTimes(1);
      expect(mockIncr).toHaveBeenCalledWith(expect.stringContaining('signup:ip:'));
    });
  });

  describe('IP limit', () => {
    it(`blocks when ip count exceeds ${SIGNUP_IP_LIMIT}`, async () => {
      const app = buildApp();
      // No fp header so only one incr call for the ip
      mockIncr.mockResolvedValueOnce(SIGNUP_IP_LIMIT + 1);
      const res = await postSignup(app, { ip: FAKE_IP });

      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('too_many_signups');
    });

    it('reads ip from x-forwarded-for when cf-connecting-ip is absent', async () => {
      const app = buildApp();
      mockIncr.mockResolvedValueOnce(1);
      const res = await postSignup(app, { forwardedFor: '10.0.0.5, 172.16.0.1' });
      expect(res.status).toBe(200);
      // The key should be derived from the first address in x-forwarded-for
      expect(mockIncr).toHaveBeenCalledWith(expect.stringContaining('signup:ip:'));
    });

    it('buckets IPs into /24 so 203.0.113.1 and 203.0.113.2 share a key', async () => {
      const app = buildApp();
      // Capture which Redis keys were passed to incr by each request.
      const capturedKeys: string[] = [];
      mockIncr.mockImplementation((...args: unknown[]) => {
        capturedKeys.push(String(args[0] ?? ''));
        return Promise.resolve(1);
      });

      await postSignup(app, { ip: '203.0.113.1' });
      const keyFromFirst = capturedKeys[0];

      capturedKeys.length = 0;
      await postSignup(app, { ip: '203.0.113.2' });
      const keyFromSecond = capturedKeys[0];

      // Both IPs must resolve to the same /24 bucket -> same Redis key
      expect(keyFromFirst).toBeTruthy();
      expect(keyFromFirst).toBe(keyFromSecond);
    });
  });

  describe('fail-open on Redis error', () => {
    it('passes through when redis.incr throws', async () => {
      const app = buildApp();
      mockIncr.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const res = await postSignup(app, { fp: FAKE_FP, ip: FAKE_IP });
      expect(res.status).toBe(200);
    });
  });

  describe('no IP and no fp', () => {
    it('passes through without calling Redis when neither header is present', async () => {
      const app = buildApp();
      const res = await postSignup(app, {});
      expect(res.status).toBe(200);
      expect(mockIncr).not.toHaveBeenCalled();
    });
  });
});
