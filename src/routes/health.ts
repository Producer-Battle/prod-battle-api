import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { readTickHeartbeat } from '../realtime/heartbeat.js';

export const healthRoutes = new OpenAPIHono();

const HealthResponse = z
  .object({
    status: z.literal('ok'),
    version: z.string(),
    uptimeSec: z.number(),
  })
  .openapi('HealthResponse');

const route = createRoute({
  method: 'get',
  path: '/health',
  tags: ['system'],
  summary: 'Liveness probe',
  responses: {
    200: {
      description: 'Service is running',
      content: { 'application/json': { schema: HealthResponse } },
    },
  },
});

// APP_VERSION is baked in at Docker build time (Dockerfile ARG, populated
// from CI's short git SHA in .github/workflows/deploy.yml). Falls back to
// 'dev' for local `pnpm dev` where no build arg was supplied.
const APP_VERSION = process.env.APP_VERSION ?? 'dev';

healthRoutes.openapi(route, (c) =>
  c.json({
    status: 'ok' as const,
    version: APP_VERSION,
    uptimeSec: Math.round(process.uptime()),
  }),
);

// Tick watchdog. The leader replica writes a Redis heartbeat each tick;
// this endpoint reads it and reports staleness. Threshold matches the
// leader-lock TTL (5s in leader.ts) - past that point, a stuck leader
// should have lost the lock to another replica; if no heartbeat exists,
// either no replica holds leadership or the leader is wedged.
//
// Returns 503 on stale/missing so any HTTP probe (UptimeRobot, Grafana,
// Scaleway healthcheck) can page without parsing the JSON body.
const TICK_STALE_MS = 5000;

const TickHealthResponse = z
  .object({
    status: z.enum(['ok', 'stale', 'missing']),
    lastTickAt: z.string().nullable(),
    ageMs: z.number().nullable(),
    thresholdMs: z.number(),
  })
  .openapi('TickHealthResponse');

const tickRoute = createRoute({
  method: 'get',
  path: '/health/tick',
  tags: ['system'],
  summary: 'Tick loop watchdog',
  responses: {
    200: {
      description: 'Tick loop is healthy',
      content: { 'application/json': { schema: TickHealthResponse } },
    },
    503: {
      description: 'Tick loop is stale or no heartbeat seen',
      content: { 'application/json': { schema: TickHealthResponse } },
    },
  },
});

healthRoutes.openapi(tickRoute, async (c) => {
  const hb = await readTickHeartbeat();
  if (!hb) {
    return c.json(
      {
        status: 'missing' as const,
        lastTickAt: null,
        ageMs: null,
        thresholdMs: TICK_STALE_MS,
      },
      503,
    );
  }
  const stale = hb.ageMs > TICK_STALE_MS;
  return c.json(
    {
      status: stale ? ('stale' as const) : ('ok' as const),
      lastTickAt: hb.lastTickAt,
      ageMs: hb.ageMs,
      thresholdMs: TICK_STALE_MS,
    },
    stale ? 503 : 200,
  );
});
