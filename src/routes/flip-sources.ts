// Public read-only endpoints for the Sample Flip source library.
// Lets the web tile show "N sources ready" and optionally filter by
// genre before creating a flip match. Writes are admin-only and live
// in admin-flip-sources.ts.

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { flipSources, genres } from '../db/schema.js';

export const flipSourcesRoutes = new OpenAPIHono();

const FlipSourceRow = z.object({
  id: z.string().uuid(),
  label: z.string(),
  genreSlug: z.string().nullable(),
  url: z.string().url(),
  durationSec: z.number().int().nullable(),
});

const listRoute = createRoute({
  method: 'get',
  path: '/flip-sources',
  tags: ['flip-sources'],
  summary: 'Active flip sources - optionally filtered by genre',
  request: {
    query: z.object({
      genreSlug: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Active flip sources',
      content: { 'application/json': { schema: z.object({ items: z.array(FlipSourceRow) }) } },
    },
  },
});

flipSourcesRoutes.openapi(listRoute, async (c) => {
  const { genreSlug } = c.req.valid('query');
  const d = db();

  let genreId: string | null = null;
  if (genreSlug) {
    const [g] = await d.select().from(genres).where(eq(genres.slug, genreSlug)).limit(1);
    genreId = g?.id ?? null;
    // If the slug doesn't resolve, just return an empty list rather than
    // a 404 - the UI can treat "no slug" and "no matches" the same way.
    if (!genreId) return c.json({ items: [] }, 200);
  }

  const rows = await d
    .select({
      id: flipSources.id,
      label: flipSources.label,
      genreSlug: genres.slug,
      url: flipSources.url,
      durationSec: flipSources.durationSec,
    })
    .from(flipSources)
    .leftJoin(genres, eq(genres.id, flipSources.genreId))
    .where(
      genreId
        ? and(eq(flipSources.active, true), eq(flipSources.genreId, genreId))
        : eq(flipSources.active, true),
    )
    .orderBy(desc(flipSources.createdAt));

  return c.json(
    {
      items: rows.map((r) => ({
        id: r.id,
        label: r.label,
        genreSlug: r.genreSlug ?? null,
        url: r.url,
        durationSec: r.durationSec ?? null,
      })),
    },
    200,
  );
});
