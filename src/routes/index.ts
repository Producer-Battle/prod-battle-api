import type { OpenAPIHono } from '@hono/zod-openapi';
import { feedRoutes } from './feed.js';
import { genresRoutes } from './genres.js';
import { healthRoutes } from './health.js';
import { matchesRoutes } from './matches.js';
import { phasesRoutes } from './phases.js';
import { roomActionsRoutes } from './room-actions.js';
import { samplePacksRoutes } from './sample-packs.js';
import { submissionsRoutes } from './submissions.js';

export function registerRoutes(app: OpenAPIHono): void {
  app.route('/', healthRoutes);
  app.route('/', feedRoutes);
  app.route('/', genresRoutes);
  app.route('/', matchesRoutes);
  app.route('/', roomActionsRoutes);
  app.route('/', samplePacksRoutes);
  app.route('/', submissionsRoutes);
  app.route('/', phasesRoutes);
  // TODO: auth, players, ar, admin
}
