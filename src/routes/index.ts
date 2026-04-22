import type { OpenAPIHono } from '@hono/zod-openapi';
import { feedRoutes } from './feed.js';
import { genresRoutes } from './genres.js';
import { healthRoutes } from './health.js';
import { matchesRoutes } from './matches.js';

export function registerRoutes(app: OpenAPIHono): void {
  app.route('/', healthRoutes);
  app.route('/', feedRoutes);
  app.route('/', genresRoutes);
  app.route('/', matchesRoutes);
  // TODO: auth, players, submissions, ar, admin
}
