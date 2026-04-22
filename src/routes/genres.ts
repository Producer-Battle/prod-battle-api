import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { genres } from '../db/schema.js';

export const genresRoutes = new OpenAPIHono();

const GenreItem = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    kind: z.enum(['system', 'user']),
  })
  .openapi('Genre');

const listRoute = createRoute({
  method: 'get',
  path: '/genres',
  tags: ['genres'],
  summary: 'List genres',
  request: {
    query: z.object({
      kind: z.enum(['system', 'user']).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Genres',
      content: {
        'application/json': { schema: z.object({ items: z.array(GenreItem) }) },
      },
    },
  },
});

genresRoutes.openapi(listRoute, async (c) => {
  const { kind } = c.req.valid('query');
  const d = db();
  const rows = await d
    .select({ id: genres.id, slug: genres.slug, name: genres.name, kind: genres.kind })
    .from(genres)
    .where(kind ? eq(genres.kind, kind) : eq(genres.status, 'active'))
    .orderBy(asc(genres.name));
  return c.json({ items: rows });
});
