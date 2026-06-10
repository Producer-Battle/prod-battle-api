// Prometheus metrics: default Node process metrics + an HTTP request
// duration histogram, exposed at GET /metrics.
//
// Scrape path: the in-cluster Prometheus (kube-prometheus-stack) scrapes
// the pod IP directly via a PodMonitor - that traffic never crosses the
// ingress. Public traffic DOES cross the ingress, which always stamps
// X-Forwarded-For - so the /metrics handler refuses any request carrying
// that header. Result: cluster-internal scrapes work, the endpoint is a
// 404 from the internet, and no token/secret needs managing.

import type { OpenAPIHono } from '@hono/zod-openapi';
import { createMiddleware } from 'hono/factory';
import { Histogram, collectDefaultMetrics, register } from 'prom-client';

collectDefaultMetrics({ prefix: 'pb_' });

const httpDuration = new Histogram({
  name: 'pb_http_request_duration_seconds',
  help: 'HTTP request duration by route pattern, method and status code.',
  labelNames: ['method', 'route', 'status'] as const,
  // Realtime API: most requests are <50ms; the tail buckets catch S3
  // presign latency and slow DB queries.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

/**
 * Times every request. Uses the matched route PATTERN (e.g.
 * /rooms/:code/join) rather than the raw path so cardinality stays
 * bounded no matter how many room codes or user handles exist.
 */
export function httpMetrics() {
  return createMiddleware(async (c, next) => {
    const start = performance.now();
    await next();
    const elapsed = (performance.now() - start) / 1000;
    const route = c.req.routePath || 'unmatched';
    // Never let metrics labels explode on the metrics endpoint itself.
    if (route === '/metrics') return;
    httpDuration.observe({ method: c.req.method, route, status: String(c.res.status) }, elapsed);
  });
}

export function registerMetricsRoute(app: OpenAPIHono): void {
  app.get('/metrics', async (c) => {
    // Ingress-originated requests carry X-Forwarded-For; direct pod
    // scrapes from Prometheus don't. Hide the endpoint from the internet.
    if (c.req.header('x-forwarded-for')) {
      return c.notFound();
    }
    const body = await register.metrics();
    return c.text(body, 200, { 'content-type': register.contentType });
  });
}
