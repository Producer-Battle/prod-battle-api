import type { OpenAPIHono } from '@hono/zod-openapi';
import { healthRoutes } from './health.js';
// Stubs — un-comment as each route group comes online.
// import { authRoutes } from './auth.js';
// import { playersRoutes } from './players.js';
// import { genresRoutes } from './genres.js';
// import { matchesRoutes } from './matches.js';
// import { submissionsRoutes } from './submissions.js';
// import { feedRoutes } from './feed.js';
// import { arRoutes } from './ar.js';
// import { adminRoutes } from './admin.js';

export function registerRoutes(app: OpenAPIHono): void {
  app.route('/', healthRoutes);
  // app.route('/auth', authRoutes);
  // app.route('/players', playersRoutes);
  // app.route('/genres', genresRoutes);
  // app.route('/matches', matchesRoutes);
  // app.route('/submissions', submissionsRoutes);
  // app.route('/feed', feedRoutes);
  // app.route('/ar', arRoutes);
  // app.route('/admin', adminRoutes);
}
