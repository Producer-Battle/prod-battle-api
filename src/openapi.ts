// Re-export for scripts/emit-openapi.ts. Separate file so the emit script can
// import just the app definition without starting the HTTP listener.
import { OpenAPIHono } from '@hono/zod-openapi';
import { registerRoutes } from './routes/index.js';

export function buildApp(): OpenAPIHono {
  const app = new OpenAPIHono();
  registerRoutes(app);
  app.doc('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Producer Battle API',
      version: '0.0.1',
    },
  });
  return app;
}
