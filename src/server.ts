import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { auth } from './auth/config.js';
import { env } from './env.js';
import { startGenrePromotionLoop } from './genres/promote.js';
import { anonId } from './middleware/anon-id.js';
import { requireSignupQuota } from './middleware/rate-limit.js';
import { attachSession } from './middleware/session.js';
import { startTickLoop } from './realtime/tick.js';
import { registerRoutes } from './routes/index.js';
import { attachWebSocket } from './ws/index.js';

const app = new OpenAPIHono();

// Entries may be exact origins ("https://prodbattle.com") or wildcard
// patterns ("https://*.news-worker.workers.dev"). Wildcards are needed
// for Cloudflare's per-version preview URLs, whose hash changes per build.
const allowedOriginPatterns = (env.AUTH_TRUSTED_ORIGINS ?? env.WEB_ORIGIN ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    if (!entry.includes('*')) return { test: (o: string) => o === entry };
    const regex = new RegExp(
      `^${entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    );
    return { test: (o: string) => regex.test(o) };
  });
app.use(
  '*',
  cors({
    origin: (origin) =>
      allowedOriginPatterns.length === 0 || allowedOriginPatterns.some((p) => p.test(origin))
        ? origin
        : null,
    credentials: true,
  }),
);

// Sign-up rate-limit: guard account creation before the better-auth handler
// sees the request. Fires on both the email/password and OAuth sign-up paths.
// Fail-open when Redis is unavailable so a Redis restart never blocks signups.
app.use('/auth/sign-up/*', requireSignupQuota());
// Google OAuth callback also creates accounts - rate-limit the callback path.
app.use('/auth/callback/*', requireSignupQuota());

// better-auth mounts its entire surface area (/sign-in, /sign-up, /session,
// /verify-email, OAuth callbacks, ...) at this one handler. Must be
// registered BEFORE attachSession so the session cookie set by /sign-up
// is available on the same response.
//
// IMPORTANT: use app.all here, NOT app.on(['GET', 'POST'], ...). In
// Hono 4.12.x app.on with a method array silently drops GET in some
// router configurations - which means /auth/verify-email (the GET
// endpoint emailed to new sign-ups) 404s while POST routes still work.
// app.all registers for every HTTP verb and avoids that footgun.
app.all('/auth/*', (c) => auth.handler(c.req.raw));

// Populate c.var.user / c.var.session for every downstream handler.
// Never blocks anonymous requests.
app.use('*', attachSession());

// Assign (or generate) a persistent anonymous identity cookie so rate-limiters
// and other per-visitor features have a stable key without requiring auth.
// Runs AFTER attachSession so authenticated users still get the cookie but
// rate-limit middleware can bail early via c.var.user.
app.use('*', anonId());

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
    { url: 'https://api.prodbattle.com', description: 'prod' },
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
const stopGenrePromotion = startGenrePromotionLoop();

const shutdown = (signal: string) => {
  console.log(`[prod-battle-api] ${signal} received, draining...`);
  stopTick();
  stopGenrePromotion();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
