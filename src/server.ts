import { serve } from '@hono/node-server';
import { OpenAPIHono } from '@hono/zod-openapi';
import { env } from './env.js';
import { registerRoutes } from './routes/index.js';

const app = new OpenAPIHono();

registerRoutes(app);

app.doc('/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'Producer Battle API',
    version: '0.0.1',
    description: 'Multi-genre producer battle platform.',
  },
  servers: [
    { url: 'http://localhost:8080', description: 'local' },
    { url: 'https://api.staging.producer-battle.app', description: 'staging' },
    { url: 'https://api.producer-battle.app', description: 'production' },
  ],
});

const server = serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  ({ address, port }) => {
    console.log(`[prod-battle-api] listening on http://${address}:${port} (${env.NODE_ENV})`);
  },
);

// TODO: wire WebSocket upgrades from ./ws/index.ts onto `server`
// TODO: start ./realtime/tick.ts leader loop

const shutdown = (signal: string) => {
  console.log(`[prod-battle-api] ${signal} received, draining…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
