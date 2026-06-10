// Unit tests for the Alertmanager -> mail-relay adapter.
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internalAlertsRoutes } from './internal-alerts.js';

const AM_PAYLOAD = {
  status: 'firing',
  alerts: [
    {
      status: 'firing',
      labels: { alertname: 'KubeJobNotCompleted', severity: 'warning', namespace: 'app' },
      annotations: { summary: 'Job app/postgres-backup is taking too long.' },
      startsAt: '2026-06-05T02:17:00Z',
    },
  ],
};

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', internalAlertsRoutes);
  return app;
}

describe('POST /internal/alertmanager', () => {
  beforeEach(() => {
    vi.stubEnv('MAIL_RELAY_URL', 'https://mail.example.test/relay');
    vi.stubEnv('MAIL_RELAY_TOKEN', 'test-token');
    vi.stubEnv('ALERT_EMAIL', 'ops@example.test');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('forwards alerts to the relay with token auth and a readable subject', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ messageId: 'x' })));
    vi.stubGlobal('fetch', fetchSpy);

    const res = await buildApp().request('/internal/alertmanager', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(AM_PAYLOAD),
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://mail.example.test/relay/send');
    expect((init.headers as Record<string, string>)['x-relay-token']).toBe('test-token');
    const sent = JSON.parse(String(init.body));
    expect(sent.to).toBe('ops@example.test');
    expect(sent.subject).toContain('1 alert firing');
    expect(sent.subject).toContain('KubeJobNotCompleted');
    expect(sent.text).toContain('severity=warning');
  });

  it('rejects ingress-originated requests (X-Forwarded-For)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await buildApp().request('/internal/alertmanager', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify(AM_PAYLOAD),
    });

    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 503 when the relay is not configured so Alertmanager retries', async () => {
    vi.stubEnv('MAIL_RELAY_URL', undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await buildApp().request('/internal/alertmanager', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(AM_PAYLOAD),
    });

    expect(res.status).toBe(503);
    expect(((await res.json()) as { reason: string }).reason).toBe('relay_not_configured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('propagates relay failure as 502 so Alertmanager retries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );

    const res = await buildApp().request('/internal/alertmanager', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(AM_PAYLOAD),
    });

    expect(res.status).toBe(502);
  });
});
