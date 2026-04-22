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

healthRoutes.openapi(route, (c) =>
  c.json({
    status: 'ok' as const,
    version: process.env.npm_package_version ?? '0.0.0',
    uptimeSec: Math.round(process.uptime()),
  }),
);
