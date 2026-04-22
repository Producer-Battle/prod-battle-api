import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { genreVotes, genres } from '../db/schema.js';

export const genresRoutes = new OpenAPIHono();

// ─── Schemas ────────────────────────────────────────────────────────────────

const GenreItem = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    kind: z.enum(['system', 'user']),
    status: z.enum(['active', 'archived', 'proposed']),
    createdBy: z.string().uuid().nullable(),
    votingEndsAt: z.string().datetime().nullable(),
    voteCount: z.number().int(),
    iVoted: z.boolean(),
  })
  .openapi('Genre');

const CreateGenreBody = z
  .object({
    // Slug: lowercase, digits, dashes. 3–32 chars. Unique across the table.
    slug: z
      .string()
      .min(3)
      .max(32)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits, and single dashes'),
    name: z.string().min(3).max(64),
  })
  .openapi('CreateGenreBody');

// ─── GET /genres ────────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/genres',
  tags: ['genres'],
  summary: 'List genres',
  request: {
    query: z.object({
      kind: z.enum(['system', 'user']).optional(),
      // When set, include user genres that are still in their voting window.
      // Otherwise returns only status='active' genres (the ones actually
      // usable for match creation).
      includeProposed: z.coerce.boolean().optional().default(false),
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
  const { kind, includeProposed } = c.req.valid('query');
  const user = c.var.user;
  const d = db();

  const statusFilter = includeProposed
    ? inArray(genres.status, ['active', 'proposed'] as const)
    : eq(genres.status, 'active');

  const rows = await d
    .select({
      id: genres.id,
      slug: genres.slug,
      name: genres.name,
      kind: genres.kind,
      status: genres.status,
      createdBy: genres.createdBy,
      votingEndsAt: genres.votingEndsAt,
    })
    .from(genres)
    .where(kind ? and(eq(genres.kind, kind), statusFilter) : statusFilter)
    .orderBy(asc(genres.name));

  if (rows.length === 0) return c.json({ items: [] });

  // Batch vote counts + my-vote flags for all genres in one round trip each.
  const ids = rows.map((r) => r.id);
  const counts = await d
    .select({ genreId: genreVotes.genreId, n: count() })
    .from(genreVotes)
    .where(inArray(genreVotes.genreId, ids))
    .groupBy(genreVotes.genreId);
  const countBy = new Map(counts.map((r) => [r.genreId, Number(r.n)]));

  const myVoteIds = new Set<string>();
  if (user) {
    const mine = await d
      .select({ genreId: genreVotes.genreId })
      .from(genreVotes)
      .where(and(inArray(genreVotes.genreId, ids), eq(genreVotes.voterId, user.id)));
    for (const r of mine) myVoteIds.add(r.genreId);
  }

  return c.json({
    items: rows.map((r) => ({
      ...r,
      votingEndsAt: r.votingEndsAt ? new Date(r.votingEndsAt).toISOString() : null,
      voteCount: countBy.get(r.id) ?? 0,
      iVoted: myVoteIds.has(r.id),
    })),
  });
});

// ─── POST /genres (create user-submitted genre) ─────────────────────────────

const VOTING_WINDOW_DAYS = 7;

const createRouteDef = createRoute({
  method: 'post',
  path: '/genres',
  tags: ['genres'],
  summary: 'Propose a new user genre',
  request: {
    body: {
      content: { 'application/json': { schema: CreateGenreBody } },
    },
  },
  responses: {
    201: {
      description: 'Created',
      content: { 'application/json': { schema: GenreItem } },
    },
    401: {
      description: 'Unauthenticated',
      content: {
        'application/json': { schema: z.object({ error: z.string(), message: z.string() }) },
      },
    },
    409: {
      description: 'Slug already taken',
      content: {
        'application/json': { schema: z.object({ error: z.string(), message: z.string() }) },
      },
    },
  },
});

genresRoutes.openapi(createRouteDef, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);

  const body = c.req.valid('json');
  const d = db();

  // Uniqueness check (the DB's unique index enforces this too, but we want a
  // clean 409 body instead of a raw duplicate-key error).
  const existing = await d
    .select({ id: genres.id })
    .from(genres)
    .where(eq(genres.slug, body.slug))
    .limit(1);
  if (existing.length > 0) {
    return c.json({ error: 'slug_taken', message: 'That slug already exists.' }, 409);
  }

  const votingEndsAt = new Date(Date.now() + VOTING_WINDOW_DAYS * 24 * 3600 * 1000);
  const [row] = await d
    .insert(genres)
    .values({
      slug: body.slug,
      name: body.name,
      kind: 'user',
      status: 'proposed',
      createdBy: user.id,
      votingEndsAt,
    })
    .returning();

  if (!row) {
    return c.json({ error: 'create_failed', message: 'Could not create genre.' }, 409);
  }

  return c.json(
    {
      id: row.id,
      slug: row.slug,
      name: row.name,
      kind: row.kind,
      status: row.status,
      createdBy: row.createdBy,
      votingEndsAt: row.votingEndsAt ? new Date(row.votingEndsAt).toISOString() : null,
      voteCount: 0,
      iVoted: false,
    },
    201,
  );
});

// ─── POST /genres/:id/vote ──────────────────────────────────────────────────

const ErrorBody = z.object({ error: z.string(), message: z.string() });

const voteRoute = createRoute({
  method: 'post',
  path: '/genres/{id}/vote',
  tags: ['genres'],
  summary: 'Vote for a proposed genre',
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Vote recorded',
      content: {
        'application/json': { schema: z.object({ voteCount: z.number().int() }) },
      },
    },
    400: {
      description: 'Voting closed or genre not in voting state',
      content: { 'application/json': { schema: ErrorBody } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: ErrorBody } },
    },
  },
});

genresRoutes.openapi(voteRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);

  const { id } = c.req.valid('param');
  const d = db();

  const [genre] = await d.select().from(genres).where(eq(genres.id, id)).limit(1);
  if (!genre) {
    return c.json({ error: 'not_found', message: 'Genre does not exist.' }, 400);
  }
  if (genre.status !== 'proposed') {
    return c.json({ error: 'not_in_voting', message: 'This genre is not open for voting.' }, 400);
  }
  if (genre.votingEndsAt && new Date(genre.votingEndsAt).getTime() < Date.now()) {
    return c.json({ error: 'voting_closed', message: 'Voting window has ended.' }, 400);
  }

  // Upsert — idempotent: a repeat vote from the same user is a no-op.
  await d
    .insert(genreVotes)
    .values({ genreId: id, voterId: user.id })
    .onConflictDoNothing({ target: [genreVotes.genreId, genreVotes.voterId] });

  const countRows = await d
    .select({ n: count() })
    .from(genreVotes)
    .where(eq(genreVotes.genreId, id));
  return c.json({ voteCount: Number(countRows[0]?.n ?? 0) }, 200);
});

// ─── DELETE /genres/:id/vote (unvote) ───────────────────────────────────────

const unvoteRoute = createRoute({
  method: 'delete',
  path: '/genres/{id}/vote',
  tags: ['genres'],
  summary: 'Retract vote for a proposed genre',
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Vote removed',
      content: {
        'application/json': { schema: z.object({ voteCount: z.number().int() }) },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: ErrorBody } },
    },
  },
});

genresRoutes.openapi(unvoteRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);

  const { id } = c.req.valid('param');
  const d = db();

  await d
    .delete(genreVotes)
    .where(and(eq(genreVotes.genreId, id), eq(genreVotes.voterId, user.id)));

  const countRows = await d
    .select({ n: count() })
    .from(genreVotes)
    .where(eq(genreVotes.genreId, id));
  return c.json({ voteCount: Number(countRows[0]?.n ?? 0) }, 200);
});
