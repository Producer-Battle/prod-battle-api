import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';

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
