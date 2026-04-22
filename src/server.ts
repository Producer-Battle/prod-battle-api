import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { env } from './env.js';
import { startTickLoop } from './realtime/tick.js';
import { registerRoutes } from './routes/index.js';
import { attachWebSocket } from './ws/index.js';

const app = new OpenAPIHono();

const allowedOrigins = (env.AUTH_TRUSTED_ORIGINS ?? env.WEB_ORIGIN ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  '*',
  cors({
    origin: (origin) =>
      allowedOrigins.length === 0 || allowedOrigins.includes(origin) ? origin : null,
    credentials: true,
  }),
);

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

const server: ServerType = serve(
  {
    fetch: app.fetch,
    port: env.PORT,
    hostname: '0.0.0.0',
  },
  ({ address, port }) => {
    console.log(`[prod-battle-api] listening on http://${address}:${port} (${env.NODE_ENV})`);
  },
);

// Wire WebSocket upgrades and start the tick loop.
// Cast to the Node.js http.Server so ws can hook the 'upgrade' event.
attachWebSocket(server as unknown as import('node:http').Server);
const stopTick = startTickLoop();

const shutdown = (signal: string) => {
  console.log(`[prod-battle-api] ${signal} received, draining…`);
  stopTick();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
