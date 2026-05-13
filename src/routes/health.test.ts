// Unit tests for the tick watchdog endpoint. The heartbeat module is mocked
// so the test never touches Redis.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const readTickHeartbeat = vi.fn();
vi.mock('../realtime/heartbeat.js', () => ({ readTickHeartbeat }));

// Import AFTER the mock so the route module picks up the stub.
const { healthRoutes } = await import('./health.js');

describe('GET /health/tick', () => {
  beforeEach(() => {
    readTickHeartbeat.mockReset();
  });

  it('returns 200 ok when heartbeat is fresh', async () => {
    readTickHeartbeat.mockResolvedValue({
      lastTickAt: new Date().toISOString(),
      ageMs: 500,
    });

    const res = await healthRoutes.request('/health/tick');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; ageMs: number; thresholdMs: number };
    expect(body.status).toBe('ok');
    expect(body.ageMs).toBe(500);
    expect(body.thresholdMs).toBe(5000);
  });

  it('returns 503 stale when heartbeat is past threshold', async () => {
    readTickHeartbeat.mockResolvedValue({
      lastTickAt: new Date(Date.now() - 10_000).toISOString(),
      ageMs: 10_000,
    });

    const res = await healthRoutes.request('/health/tick');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; ageMs: number };
    expect(body.status).toBe('stale');
    expect(body.ageMs).toBe(10_000);
  });

  it('returns 503 missing when no heartbeat exists', async () => {
    readTickHeartbeat.mockResolvedValue(null);

    const res = await healthRoutes.request('/health/tick');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; lastTickAt: string | null };
    expect(body.status).toBe('missing');
    expect(body.lastTickAt).toBeNull();
  });
});
