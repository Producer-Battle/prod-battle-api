// Unit tests for the Prometheus /metrics endpoint + request histogram.
import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { httpMetrics, registerMetricsRoute } from './metrics.js';

function buildApp(): OpenAPIHono {
  const app = new OpenAPIHono();
  app.use('*', httpMetrics());
  registerMetricsRoute(app);
  app.get('/ping/:id', (c) => c.text('pong'));
  return app;
}

describe('GET /metrics', () => {
  it('serves prom text with default metrics and the request histogram', async () => {
    const app = buildApp();
    await app.request('/ping/abc123');

    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('pb_process_cpu');
    expect(body).toContain('pb_http_request_duration_seconds_bucket');
    // Route label is the matched PATTERN, not the raw path - keeps label
    // cardinality bounded.
    expect(body).toContain('route="/ping/:id"');
    expect(body).not.toContain('abc123');
  });

  it('hides the endpoint from ingress-originated (X-Forwarded-For) traffic', async () => {
    const app = buildApp();
    const res = await app.request('/metrics', {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect(res.status).toBe(404);
  });
});
