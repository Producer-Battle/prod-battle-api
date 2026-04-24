// Admin endpoints - all gated behind role='admin'.
//
// Scope: give a trusted operator enough handles to keep the platform
// running day-to-day without writing SQL: promote/demote users,
// create system genres + packs, peek at live matches.
//
// Shape: every handler rejects anyone without role=admin via c.var.user,
// returns structured JSON (no HTML admin panel here - frontend in
// prod-battle-web wires the dashboard against these endpoints).

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type SamplePackItem,
  genres,
  matches,
  samplePacks,
  sessions,
  userRole as userRoleEnum,
  users,
} from '../db/schema.js';

export const adminRoutes = new OpenAPIHono();

const AdminError = z.object({ error: z.string(), message: z.string() });

const requireAdmin = (
  c: Parameters<Parameters<typeof adminRoutes.openapi>[1]>[0],
):
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; body: { error: string; message: string } } => {
  const user = c.var.user;
  if (!user)
    return { ok: false, status: 401, body: { error: 'unauthenticated', message: 'Sign in.' } };
  if (user.role !== 'admin')
    return {
      ok: false,
      status: 403,
      body: { error: 'forbidden', message: 'Admin role required.' },
    };
  return { ok: true, userId: user.id };
};

const ROLES = ['producer', 'ar', 'admin'] as const;

// ─── GET /admin/overview ─────────────────────────────────────────────────────

const overviewRoute = createRoute({
  method: 'get',
  path: '/admin/overview',
  tags: ['admin'],
  summary: 'Dashboard counts (users, matches, genres, packs)',
  responses: {
    200: {
      description: 'Overview',
      content: {
        'application/json': {
          schema: z.object({
            users: z.object({
              total: z.number().int(),
              producers: z.number().int(),
              ars: z.number().int(),
              admins: z.number().int(),
            }),
            matches: z.object({
              total: z.number().int(),
              live: z.number().int(), // status in (lobby, submit, reveal, vote)
            }),
            genres: z.object({
              system: z.number().int(),
              userProposed: z.number().int(),
              userActive: z.number().int(),
            }),
            samplePacks: z.number().int(),
          }),
        },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
  },
});

adminRoutes.openapi(overviewRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const d = db();
  const [userCounts] = await d.execute<{
    total: string;
    producers: string;
    ars: string;
    admins: string;
  }>(sql`
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE role = 'producer')::text AS producers,
      COUNT(*) FILTER (WHERE role = 'ar')::text        AS ars,
      COUNT(*) FILTER (WHERE role = 'admin')::text     AS admins
    FROM users
    WHERE status = 'active'
  `);

  const [matchCounts] = await d.execute<{ total: string; live: string }>(sql`
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE status IN ('lobby','submit','reveal','vote'))::text AS live
    FROM matches
  `);

  const [genreCounts] = await d.execute<{
    system: string;
    user_proposed: string;
    user_active: string;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE kind = 'system' AND status = 'active')::text AS system,
      COUNT(*) FILTER (WHERE kind = 'user'   AND status = 'proposed')::text AS user_proposed,
      COUNT(*) FILTER (WHERE kind = 'user'   AND status = 'active')::text   AS user_active
    FROM genres
  `);

  const [packCount] = await d.execute<{ n: string }>(
    sql`SELECT COUNT(*)::text AS n FROM sample_packs`,
  );

  return c.json(
    {
      users: {
        total: Number(userCounts?.total ?? 0),
        producers: Number(userCounts?.producers ?? 0),
        ars: Number(userCounts?.ars ?? 0),
        admins: Number(userCounts?.admins ?? 0),
      },
      matches: {
        total: Number(matchCounts?.total ?? 0),
        live: Number(matchCounts?.live ?? 0),
      },
      genres: {
        system: Number(genreCounts?.system ?? 0),
        userProposed: Number(genreCounts?.user_proposed ?? 0),
        userActive: Number(genreCounts?.user_active ?? 0),
      },
      samplePacks: Number(packCount?.n ?? 0),
    },
    200,
  );
});

// ─── GET /admin/matches/live ────────────────────────────────────────────────

const liveMatchesRoute = createRoute({
  method: 'get',
  path: '/admin/matches/live',
  tags: ['admin'],
  summary: 'Live matches (status in lobby/submit/reveal/vote)',
  responses: {
    200: {
      description: 'Live matches',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                roomCode: z.string().nullable(),
                mode: z.string(),
                status: z.string(),
                genreSlug: z.string(),
                playerCount: z.number().int(),
                teamCapacity: z.number().int(),
                createdAt: z.string().datetime(),
              }),
            ),
          }),
        },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
  },
});

adminRoutes.openapi(liveMatchesRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const d = db();
  const rows = await d.execute<{
    id: string;
    room_code: string | null;
    mode: string;
    status: string;
    genre_slug: string;
    player_count: number;
    team_capacity: number;
    created_at: string;
  }>(sql`
    SELECT m.id, m.room_code, m.mode, m.status,
           g.slug AS genre_slug,
           (SELECT COUNT(*)::int FROM match_players
             WHERE match_id = m.id AND is_spectator = false) AS player_count,
           (m.team_size * m.team_count) AS team_capacity,
           m.created_at
      FROM matches m
      JOIN genres g ON g.id = m.primary_genre_id
     WHERE m.status IN ('lobby','submit','reveal','vote')
     ORDER BY m.created_at DESC
     LIMIT 100
  `);

  return c.json(
    {
      items: rows.map((r) => ({
        id: r.id,
        roomCode: r.room_code,
        mode: r.mode,
        status: r.status,
        genreSlug: r.genre_slug,
        playerCount: Number(r.player_count),
        teamCapacity: Number(r.team_capacity),
        createdAt: new Date(r.created_at).toISOString(),
      })),
    },
    200,
  );
});

// ─── GET /admin/users ────────────────────────────────────────────────────────

const listUsersRoute = createRoute({
  method: 'get',
  path: '/admin/users',
  tags: ['admin'],
  summary: 'List users (paginated, most-recent first)',
  request: {
    query: z.object({
      q: z.string().optional(), // ilike match on email OR handle
      role: z.enum(ROLES).optional(),
      // active (default): normal users only - hides soft-deleted + archived.
      // archived / deleted: only that bucket.
      // all: every row regardless of status.
      status: z.enum(['active', 'archived', 'deleted', 'all']).default('active'),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
  responses: {
    200: {
      description: 'Users',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                email: z.string(),
                handle: z.string(),
                role: z.enum(ROLES),
                status: z.enum(['active', 'archived', 'deleted']),
                createdAt: z.string().datetime(),
              }),
            ),
            total: z.number().int(),
          }),
        },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
  },
});

adminRoutes.openapi(listUsersRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { q, role, status, limit, offset } = c.req.valid('query');
  const d = db();

  const qLike = q ? `%${q}%` : null;
  const statusFilter = status === 'all' ? null : status;
  const rows = await d.execute<{
    id: string;
    email: string;
    handle: string;
    role: 'producer' | 'ar' | 'admin';
    status: 'active' | 'archived' | 'deleted';
    created_at: string;
  }>(sql`
    SELECT id, email, handle, role, status, created_at
      FROM users
     WHERE (${qLike}::text IS NULL OR email ILIKE ${qLike} OR handle ILIKE ${qLike})
       AND (${role ?? null}::user_role IS NULL OR role = ${role ?? null}::user_role)
       AND (${statusFilter}::user_status IS NULL OR status = ${statusFilter}::user_status)
     ORDER BY created_at DESC
     LIMIT ${limit}
    OFFSET ${offset}
  `);

  const [totalRow] = await d.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM users
     WHERE (${qLike}::text IS NULL OR email ILIKE ${qLike} OR handle ILIKE ${qLike})
       AND (${role ?? null}::user_role IS NULL OR role = ${role ?? null}::user_role)
       AND (${statusFilter}::user_status IS NULL OR status = ${statusFilter}::user_status)
  `);

  return c.json(
    {
      items: rows.map((r) => ({
        id: r.id,
        email: r.email,
        handle: r.handle,
        role: r.role,
        status: r.status,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      total: Number(totalRow?.n ?? 0),
    },
    200,
  );
});

// ─── PATCH /admin/users/:id/role ────────────────────────────────────────────

const setRoleRoute = createRoute({
  method: 'patch',
  path: '/admin/users/{id}/role',
  tags: ['admin'],
  summary: 'Change a user role',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': { schema: z.object({ role: z.enum(ROLES) }) },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated',
      content: {
        'application/json': {
          schema: z.object({ id: z.string().uuid(), role: z.enum(ROLES) }),
        },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
    404: { description: 'Not found', content: { 'application/json': { schema: AdminError } } },
  },
});

adminRoutes.openapi(setRoleRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { id } = c.req.valid('param');
  const { role } = c.req.valid('json');
  const d = db();

  const [updated] = await d
    .update(users)
    .set({ role, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning({ id: users.id, role: users.role });

  if (!updated) return c.json({ error: 'not_found', message: 'No such user.' }, 404);
  return c.json({ id: updated.id, role: updated.role }, 200);
});

// ─── POST /admin/genres ──────────────────────────────────────────────────────

const createSystemGenreRoute = createRoute({
  method: 'post',
  path: '/admin/genres',
  tags: ['admin'],
  summary: 'Create a system genre (immediately public)',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            slug: z
              .string()
              .min(2)
              .max(48)
              .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
            name: z.string().min(2).max(64),
            stemTypes: z.array(z.string()).min(3).max(12),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Created',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string().uuid(),
            slug: z.string(),
            name: z.string(),
          }),
        },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
    409: { description: 'Slug taken', content: { 'application/json': { schema: AdminError } } },
  },
});

adminRoutes.openapi(createSystemGenreRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const body = c.req.valid('json');
  const d = db();

  const existing = await d
    .select({ id: genres.id })
    .from(genres)
    .where(eq(genres.slug, body.slug))
    .limit(1);
  if (existing.length > 0) {
    return c.json({ error: 'slug_taken', message: 'That slug already exists.' }, 409);
  }

  const [row] = await d
    .insert(genres)
    .values({
      slug: body.slug,
      name: body.name,
      kind: 'system',
      status: 'active',
      createdBy: g.userId,
      stemTypes: body.stemTypes,
    })
    .returning({ id: genres.id, slug: genres.slug, name: genres.name });

  if (!row) return c.json({ error: 'create_failed', message: 'Could not create.' }, 409);
  return c.json(row, 201);
});

// ─── POST /admin/genres/:id/promote ─────────────────────────────────────────

const promoteGenreRoute = createRoute({
  method: 'post',
  path: '/admin/genres/{id}/promote',
  tags: ['admin'],
  summary: 'Force-promote a proposed genre to active (bypass community vote)',
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Promoted',
      content: {
        'application/json': {
          schema: z.object({ id: z.string().uuid(), status: z.literal('active') }),
        },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
    404: { description: 'Not found', content: { 'application/json': { schema: AdminError } } },
  },
});

adminRoutes.openapi(promoteGenreRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { id } = c.req.valid('param');
  const d = db();

  const [updated] = await d
    .update(genres)
    .set({ status: 'active', votingEndsAt: null })
    .where(eq(genres.id, id))
    .returning({ id: genres.id });

  if (!updated) return c.json({ error: 'not_found', message: 'No such genre.' }, 404);
  return c.json({ id: updated.id, status: 'active' as const }, 200);
});

// ─── POST /admin/sample-packs ────────────────────────────────────────────────

const createSamplePackRoute = createRoute({
  method: 'post',
  path: '/admin/sample-packs',
  tags: ['admin'],
  summary: 'Create a sample pack (links to a genre)',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            genreId: z.string().uuid(),
            name: z.string().min(2).max(64),
            kind: z.enum(['uploaded', 'generated', 'pool']).default('pool'),
            samples: z.array(
              z.object({
                stemType: z.string(),
                name: z.string(),
                url: z.string().url(),
              }),
            ),
            zipUrl: z.string().url().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Created',
      content: {
        'application/json': {
          schema: z.object({ id: z.string().uuid(), genreId: z.string().uuid() }),
        },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
    404: {
      description: 'Genre not found',
      content: { 'application/json': { schema: AdminError } },
    },
  },
});

adminRoutes.openapi(createSamplePackRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const body = c.req.valid('json');
  const d = db();

  const [genre] = await d
    .select({ id: genres.id })
    .from(genres)
    .where(eq(genres.id, body.genreId))
    .limit(1);
  if (!genre) return c.json({ error: 'genre_not_found', message: 'No such genre.' }, 404);

  const [row] = await d
    .insert(samplePacks)
    .values({
      genreId: body.genreId,
      kind: body.kind,
      name: body.name,
      createdBy: g.userId,
      samples: body.samples as SamplePackItem[],
      zipUrl: body.zipUrl ?? null,
    })
    .returning({ id: samplePacks.id, genreId: samplePacks.genreId });

  if (!row) return c.json({ error: 'create_failed', message: 'Could not create.' }, 404);
  return c.json(row, 201);
});

// ─── GET /admin/genres ───────────────────────────────────────────────────────

const listGenresRoute = createRoute({
  method: 'get',
  path: '/admin/genres',
  tags: ['admin'],
  summary: 'List all genres (all kinds, all statuses)',
  request: {
    query: z.object({
      kind: z.enum(['system', 'user']).optional(),
      status: z.enum(['active', 'archived', 'proposed']).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Genres',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                slug: z.string(),
                name: z.string(),
                kind: z.enum(['system', 'user']),
                status: z.enum(['active', 'archived', 'proposed']),
                stemTypes: z.array(z.string()).nullable(),
                voteCount: z.number().int(),
                createdAt: z.string().datetime(),
              }),
            ),
          }),
        },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
  },
});

adminRoutes.openapi(listGenresRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { kind, status } = c.req.valid('query');
  const d = db();

  const rows = await d.execute<{
    id: string;
    slug: string;
    name: string;
    kind: 'system' | 'user';
    status: 'active' | 'archived' | 'proposed';
    stem_types: string[] | null;
    vote_count: string;
    created_at: string;
  }>(sql`
    SELECT
      g.id, g.slug, g.name, g.kind, g.status, g.stem_types,
      COUNT(gv.genre_id)::text AS vote_count,
      g.created_at
    FROM genres g
    LEFT JOIN genre_votes gv ON gv.genre_id = g.id
    WHERE (${kind ?? null}::genre_kind IS NULL OR g.kind = ${kind ?? null}::genre_kind)
      AND (${status ?? null}::genre_status IS NULL OR g.status = ${status ?? null}::genre_status)
    GROUP BY g.id
    ORDER BY g.created_at DESC
  `);

  return c.json(
    {
      items: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        kind: r.kind,
        status: r.status,
        stemTypes: r.stem_types ?? null,
        voteCount: Number(r.vote_count),
        createdAt: new Date(r.created_at).toISOString(),
      })),
    },
    200,
  );
});

// ─── PATCH /admin/genres/:id ─────────────────────────────────────────────────

const updateGenreRoute = createRoute({
  method: 'patch',
  path: '/admin/genres/{id}',
  tags: ['admin'],
  summary: 'Update genre name, stemTypes, or status (active<->archived only)',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(2).max(64).optional(),
            stemTypes: z.array(z.string()).min(1).max(20).optional(),
            status: z.enum(['active', 'archived']).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string().uuid(),
            slug: z.string(),
            name: z.string(),
            status: z.enum(['active', 'archived', 'proposed']),
            stemTypes: z.array(z.string()).nullable(),
          }),
        },
      },
    },
    400: { description: 'Bad request', content: { 'application/json': { schema: AdminError } } },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
    404: { description: 'Not found', content: { 'application/json': { schema: AdminError } } },
  },
});

adminRoutes.openapi(updateGenreRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const d = db();

  // Guard: status transitions from proposed must go through /promote.
  if (body.status === 'active') {
    const [existing] = await d
      .select({ status: genres.status })
      .from(genres)
      .where(eq(genres.id, id))
      .limit(1);
    if (existing?.status === 'proposed') {
      return c.json(
        {
          error: 'use_promote',
          message: 'Promote proposed genres via POST /admin/genres/:id/promote instead.',
        },
        400,
      );
    }
  }

  const updateValues: Record<string, unknown> = {};
  if (body.name !== undefined) updateValues.name = body.name;
  if (body.stemTypes !== undefined) updateValues.stemTypes = body.stemTypes;
  if (body.status !== undefined) updateValues.status = body.status;

  if (Object.keys(updateValues).length === 0) {
    return c.json({ error: 'no_fields', message: 'No fields to update.' }, 400);
  }

  const [updated] = await d.update(genres).set(updateValues).where(eq(genres.id, id)).returning({
    id: genres.id,
    slug: genres.slug,
    name: genres.name,
    status: genres.status,
    stemTypes: genres.stemTypes,
  });

  if (!updated) return c.json({ error: 'not_found', message: 'No such genre.' }, 404);
  return c.json(
    {
      id: updated.id,
      slug: updated.slug,
      name: updated.name,
      status: updated.status,
      stemTypes: updated.stemTypes ?? null,
    },
    200,
  );
});

// ─── DELETE /admin/genres/:id ────────────────────────────────────────────────

const deleteGenreRoute = createRoute({
  method: 'delete',
  path: '/admin/genres/{id}',
  tags: ['admin'],
  summary: 'Hard-delete a genre. Returns 409 if any match references it.',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    204: { description: 'Deleted' },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
    404: { description: 'Not found', content: { 'application/json': { schema: AdminError } } },
    409: {
      description: 'Referenced by matches',
      content: { 'application/json': { schema: AdminError } },
    },
  },
});

adminRoutes.openapi(deleteGenreRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { id } = c.req.valid('param');
  const d = db();

  // Check FK: matches.primary_genre_id is ON DELETE RESTRICT.
  const [matchRef] = await d.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM matches WHERE primary_genre_id = ${id}
  `);
  if (Number(matchRef?.n ?? 0) > 0) {
    return c.json(
      {
        error: 'genre_in_use',
        message: `Cannot delete: ${matchRef?.n} match(es) reference this genre.`,
      },
      409,
    );
  }

  const [row] = await d.delete(genres).where(eq(genres.id, id)).returning({ id: genres.id });
  if (!row) return c.json({ error: 'not_found', message: 'No such genre.' }, 404);
  return c.body(null, 204);
});

// ─── DELETE /admin/users/:id ─────────────────────────────────────────────────

const deleteUserRoute = createRoute({
  method: 'delete',
  path: '/admin/users/{id}',
  tags: ['admin'],
  summary: 'Soft-delete a user (anonymise email, handle, avatar). Refuses self-delete.',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    204: { description: 'Soft-deleted' },
    400: {
      description: 'Self-delete refused',
      content: { 'application/json': { schema: AdminError } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
    404: { description: 'Not found', content: { 'application/json': { schema: AdminError } } },
  },
});

adminRoutes.openapi(deleteUserRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { id } = c.req.valid('param');

  if (id === g.userId) {
    return c.json({ error: 'self_delete', message: 'Cannot delete your own account.' }, 400);
  }

  const d = db();
  // Generate a short unique suffix so handle remains unique after multiple deletes.
  const shortId = id.slice(0, 8);

  const [row] = await d
    .update(users)
    .set({
      email: `${id}@deleted.local`,
      handle: `_deleted_${shortId}`,
      avatarUrl: null,
      status: 'deleted',
      updatedAt: new Date(),
    })
    .where(eq(users.id, id))
    .returning({ id: users.id });

  if (!row) return c.json({ error: 'not_found', message: 'No such user.' }, 404);

  // Kill every active session so the browser is logged out on next request
  // instead of carrying a stale cookie for the lifetime of the session.
  await d.delete(sessions).where(eq(sessions.userId, id));

  return c.body(null, 204);
});

// ─── GET /admin/matches ───────────────────────────────────────────────────────

const listMatchesRoute = createRoute({
  method: 'get',
  path: '/admin/matches',
  tags: ['admin'],
  summary: 'Paginated list of all matches (not just live)',
  request: {
    query: z.object({
      status: z.enum(['lobby', 'submit', 'reveal', 'vote', 'results', 'cancelled']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
  responses: {
    200: {
      description: 'Matches',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                roomCode: z.string().nullable(),
                mode: z.string(),
                genreSlug: z.string(),
                status: z.string(),
                seated: z.number().int(),
                capacity: z.number().int(),
                submissionCount: z.number().int(),
                createdAt: z.string().datetime(),
              }),
            ),
            total: z.number().int(),
          }),
        },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
  },
});

adminRoutes.openapi(listMatchesRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { status, limit, offset } = c.req.valid('query');
  const d = db();

  const rows = await d.execute<{
    id: string;
    room_code: string | null;
    mode: string;
    genre_slug: string;
    status: string;
    seated: string;
    capacity: string;
    submission_count: string;
    created_at: string;
  }>(sql`
    SELECT
      m.id,
      m.room_code,
      m.mode,
      g.slug AS genre_slug,
      m.status,
      (SELECT COUNT(*)::int FROM match_players mp WHERE mp.match_id = m.id AND mp.is_spectator = false) AS seated,
      (m.team_size * m.team_count) AS capacity,
      (SELECT COUNT(*)::int FROM submissions s WHERE s.match_id = m.id) AS submission_count,
      m.created_at
    FROM matches m
    JOIN genres g ON g.id = m.primary_genre_id
    WHERE (${status ?? null}::match_status IS NULL OR m.status = ${status ?? null}::match_status)
    ORDER BY m.created_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `);

  const [totalRow] = await d.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM matches m
    WHERE (${status ?? null}::match_status IS NULL OR m.status = ${status ?? null}::match_status)
  `);

  return c.json(
    {
      items: rows.map((r) => ({
        id: r.id,
        roomCode: r.room_code ?? null,
        mode: r.mode,
        genreSlug: r.genre_slug,
        status: r.status,
        seated: Number(r.seated),
        capacity: Number(r.capacity),
        submissionCount: Number(r.submission_count),
        createdAt: new Date(r.created_at).toISOString(),
      })),
      total: Number(totalRow?.n ?? 0),
    },
    200,
  );
});

// ─── POST /admin/matches/:id/cancel ──────────────────────────────────────────

const cancelMatchRoute = createRoute({
  method: 'post',
  path: '/admin/matches/{id}/cancel',
  tags: ['admin'],
  summary: 'Set match status to cancelled',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Cancelled',
      content: {
        'application/json': {
          schema: z.object({ id: z.string().uuid(), status: z.literal('cancelled') }),
        },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
    404: { description: 'Not found', content: { 'application/json': { schema: AdminError } } },
  },
});

adminRoutes.openapi(cancelMatchRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { id } = c.req.valid('param');
  const d = db();

  const [updated] = await d
    .update(matches)
    .set({ status: 'cancelled', endedAt: new Date() })
    .where(eq(matches.id, id))
    .returning({ id: matches.id });

  if (!updated) return c.json({ error: 'not_found', message: 'No such match.' }, 404);
  return c.json({ id: updated.id, status: 'cancelled' as const }, 200);
});

// ─── DELETE /admin/matches/:id ────────────────────────────────────────────────

const deleteMatchRoute = createRoute({
  method: 'delete',
  path: '/admin/matches/{id}',
  tags: ['admin'],
  summary: 'Hard-delete a match row. FK cascades handle submissions/players.',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    204: { description: 'Deleted' },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: AdminError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: AdminError } } },
    404: { description: 'Not found', content: { 'application/json': { schema: AdminError } } },
  },
});

adminRoutes.openapi(deleteMatchRoute, async (c) => {
  const g = requireAdmin(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { id } = c.req.valid('param');
  const [row] = await db().delete(matches).where(eq(matches.id, id)).returning({ id: matches.id });
  if (!row) return c.json({ error: 'not_found', message: 'No such match.' }, 404);
  return c.body(null, 204);
});

// Keep the enum import anchored for drizzle inference.
void userRoleEnum;
void inArray;
void desc;
