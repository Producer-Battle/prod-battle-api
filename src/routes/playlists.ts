// Monthly playlist routes - supporter perk #7.
//
// Admin endpoints (role='admin'):
//   POST /admin/playlists            - create or upsert playlist by month
//   GET  /admin/playlists            - list all playlists (last 12)
//
// Supporter endpoints (plan='paid'):
//   GET  /supporter/playlists        - list published playlists (last 12)
//   GET  /supporter/playlists/:month - one playlist with full submission detail + signed audio

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { signUrl } from '../audio/s3.js';
import { db } from '../db/client.js';

export const playlistsRoutes = new OpenAPIHono();

const PlaylistError = z.object({ error: z.string(), message: z.string() });

// ─── Shared guards ──────────────────────────────────────────────────────────

type HonoCtx = Parameters<Parameters<typeof playlistsRoutes.openapi>[1]>[0];

function requireAdminGuard(c: HonoCtx) {
  const user = c.var.user;
  if (!user)
    return {
      ok: false as const,
      status: 401 as const,
      body: { error: 'unauthenticated', message: 'Sign in.' },
    };
  if (user.role !== 'admin')
    return {
      ok: false as const,
      status: 403 as const,
      body: { error: 'forbidden', message: 'Admin role required.' },
    };
  return { ok: true as const, userId: user.id };
}

function requireSupporterGuard(c: HonoCtx) {
  const user = c.var.user;
  if (!user)
    return {
      ok: false as const,
      status: 401 as const,
      body: { error: 'unauthenticated', message: 'Sign in.' },
    };
  if (user.plan !== 'paid' && user.role !== 'admin')
    return {
      ok: false as const,
      status: 402 as const,
      body: {
        error: 'supporter_only',
        message: 'Monthly playlists are a Supporter perk. Upgrade at /billing.',
      },
    };
  return { ok: true as const, userId: user.id };
}

// ─── Shared schemas ─────────────────────────────────────────────────────────

const PlaylistSummary = z.object({
  id: z.string().uuid(),
  month: z.string(), // YYYY-MM-01
  title: z.string(),
  description: z.string().nullable(),
  submissionCount: z.number().int(),
  publishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

const SubmissionDetail = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
  audioUrl: z.string(),
  waveformUrl: z.string().nullable(),
  score: z.number(),
  finalRank: z.number().int().nullable(),
  producerHandle: z.string(),
  isSupporter: z.boolean(),
  genreSlug: z.string(),
  createdAt: z.string().datetime(),
});

const PlaylistDetail = z.object({
  id: z.string().uuid(),
  month: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  publishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  submissions: z.array(SubmissionDetail),
});

// ─── POST /admin/playlists ──────────────────────────────────────────────────

const createPlaylistBody = z.object({
  month: z.string().regex(/^\d{4}-\d{2}-01$/, 'month must be YYYY-MM-01'),
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  submissionIds: z.array(z.string().uuid()),
  // When true, set published_at = NOW() so supporters can see it.
  publish: z.boolean().default(false),
});

const adminCreatePlaylistRoute = createRoute({
  method: 'post',
  path: '/admin/playlists',
  tags: ['playlists'],
  summary: 'Create or upsert a monthly playlist (admin only)',
  request: {
    body: { content: { 'application/json': { schema: createPlaylistBody } } },
  },
  responses: {
    200: {
      description: 'Created or updated',
      content: { 'application/json': { schema: PlaylistSummary } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: PlaylistError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: PlaylistError } } },
  },
});

playlistsRoutes.openapi(adminCreatePlaylistRoute, async (c) => {
  const g = requireAdminGuard(c);
  if (!g.ok) return c.json(g.body, g.status);

  const body = c.req.valid('json');
  const d = db();

  type UpsertRow = {
    id: string;
    month: string;
    title: string;
    description: string | null;
    submission_ids: string[];
    published_at: string | null;
    created_at: string;
  };

  const publishedAt = body.publish ? new Date().toISOString() : null;

  const rows = await d.execute<UpsertRow>(sql`
    INSERT INTO monthly_playlists (month, curator_user_id, title, description, submission_ids, published_at)
    VALUES (
      ${body.month}::date,
      ${g.userId},
      ${body.title},
      ${body.description ?? null},
      ${body.submissionIds}::uuid[],
      ${publishedAt}::timestamptz
    )
    ON CONFLICT (month) DO UPDATE SET
      curator_user_id = EXCLUDED.curator_user_id,
      title           = EXCLUDED.title,
      description     = EXCLUDED.description,
      submission_ids  = EXCLUDED.submission_ids,
      published_at    = COALESCE(EXCLUDED.published_at, monthly_playlists.published_at)
    RETURNING id, month::text, title, description, submission_ids, published_at::text, created_at::text
  `);

  const row = rows[0];
  if (!row)
    return c.json({ error: 'create_failed', message: 'Could not upsert playlist.' }, 500 as never);

  return c.json(
    {
      id: row.id,
      month: row.month,
      title: row.title,
      description: row.description,
      submissionCount: (row.submission_ids ?? []).length,
      publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
    },
    200,
  );
});

// ─── GET /admin/playlists ──────────────────────────────────────────────────

const adminListPlaylistsRoute = createRoute({
  method: 'get',
  path: '/admin/playlists',
  tags: ['playlists'],
  summary: 'List all playlists (admin only, last 12)',
  responses: {
    200: {
      description: 'Playlists',
      content: {
        'application/json': {
          schema: z.object({ items: z.array(PlaylistSummary) }),
        },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: PlaylistError } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: PlaylistError } } },
  },
});

playlistsRoutes.openapi(adminListPlaylistsRoute, async (c) => {
  const g = requireAdminGuard(c);
  if (!g.ok) return c.json(g.body, g.status);

  const d = db();

  type ListRow = {
    id: string;
    month: string;
    title: string;
    description: string | null;
    submission_ids: string[];
    published_at: string | null;
    created_at: string;
  };

  const rows = await d.execute<ListRow>(sql`
    SELECT id, month::text, title, description, submission_ids,
           published_at::text, created_at::text
      FROM monthly_playlists
     ORDER BY month DESC
     LIMIT 12
  `);

  return c.json(
    {
      items: (rows as ListRow[]).map((r) => ({
        id: r.id,
        month: r.month,
        title: r.title,
        description: r.description,
        submissionCount: (r.submission_ids ?? []).length,
        publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    },
    200,
  );
});

// ─── GET /supporter/playlists ──────────────────────────────────────────────

const supporterListPlaylistsRoute = createRoute({
  method: 'get',
  path: '/supporter/playlists',
  tags: ['playlists'],
  summary: 'List published monthly playlists (Supporter only, last 12)',
  responses: {
    200: {
      description: 'Published playlists',
      content: {
        'application/json': {
          schema: z.object({ items: z.array(PlaylistSummary) }),
        },
      },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: PlaylistError } },
    },
    402: {
      description: 'Supporter plan required',
      content: { 'application/json': { schema: PlaylistError } },
    },
  },
});

playlistsRoutes.openapi(supporterListPlaylistsRoute, async (c) => {
  const g = requireSupporterGuard(c);
  if (!g.ok) return c.json(g.body, g.status);

  const d = db();

  type ListRow = {
    id: string;
    month: string;
    title: string;
    description: string | null;
    submission_ids: string[];
    published_at: string;
    created_at: string;
  };

  const rows = await d.execute<ListRow>(sql`
    SELECT id, month::text, title, description, submission_ids,
           published_at::text, created_at::text
      FROM monthly_playlists
     WHERE published_at IS NOT NULL
     ORDER BY month DESC
     LIMIT 12
  `);

  return c.json(
    {
      items: (rows as ListRow[]).map((r) => ({
        id: r.id,
        month: r.month,
        title: r.title,
        description: r.description,
        submissionCount: (r.submission_ids ?? []).length,
        publishedAt: new Date(r.published_at).toISOString(),
        createdAt: new Date(r.created_at).toISOString(),
      })),
    },
    200,
  );
});

// ─── GET /supporter/playlists/:month ──────────────────────────────────────────

const supporterGetPlaylistRoute = createRoute({
  method: 'get',
  path: '/supporter/playlists/{month}',
  tags: ['playlists'],
  summary: 'Get a single published playlist with full submission detail (Supporter only)',
  request: {
    params: z.object({ month: z.string() }),
  },
  responses: {
    200: {
      description: 'Playlist with tracks',
      content: { 'application/json': { schema: PlaylistDetail } },
    },
    401: {
      description: 'Unauthenticated',
      content: { 'application/json': { schema: PlaylistError } },
    },
    402: {
      description: 'Supporter plan required',
      content: { 'application/json': { schema: PlaylistError } },
    },
    404: {
      description: 'Not found or not published',
      content: { 'application/json': { schema: PlaylistError } },
    },
  },
});

playlistsRoutes.openapi(supporterGetPlaylistRoute, async (c) => {
  const g = requireSupporterGuard(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { month } = c.req.valid('param');
  const d = db();

  type PlaylistRow = {
    id: string;
    month: string;
    title: string;
    description: string | null;
    submission_ids: string[];
    published_at: string;
    created_at: string;
  };

  const [playlist] = await d.execute<PlaylistRow>(sql`
    SELECT id, month::text, title, description, submission_ids,
           published_at::text, created_at::text
      FROM monthly_playlists
     WHERE month = ${month}::date
       AND published_at IS NOT NULL
     LIMIT 1
  `);

  if (!playlist) {
    return c.json({ error: 'not_found', message: 'Playlist not found or not published.' }, 404);
  }

  const submissionIds: string[] = playlist.submission_ids ?? [];

  // Fetch full submission details ordered by the stored array order.
  type SubRow = {
    id: string;
    title: string | null;
    audio_url: string;
    waveform_url: string | null;
    score: string;
    final_rank: number | null;
    producer_handle: string;
    producer_plan: string;
    genre_slug: string;
    created_at: string;
  };

  let submissions: z.infer<typeof SubmissionDetail>[] = [];
  if (submissionIds.length > 0) {
    const subRows = await d.execute<SubRow>(sql`
      SELECT s.id,
             s.title,
             s.audio_url,
             s.waveform_url,
             s.score::text,
             s.final_rank,
             u.handle AS producer_handle,
             u.plan AS producer_plan,
             g.slug AS genre_slug,
             s.created_at::text
        FROM submissions s
        JOIN users u ON u.id = s.user_id
        JOIN genres g ON g.id = s.genre_id
       WHERE s.id = ANY(${submissionIds}::uuid[])
    `);

    const byId = new Map((subRows as SubRow[]).map((r) => [r.id, r]));
    submissions = await Promise.all(
      submissionIds
        .filter((id) => byId.has(id))
        .map(async (id) => {
          const s = byId.get(id) as NonNullable<ReturnType<typeof byId.get>>;
          return {
            id: s.id,
            title: s.title,
            audioUrl: await signUrl(s.audio_url, 3600),
            waveformUrl: s.waveform_url ? await signUrl(s.waveform_url, 3600) : null,
            score: Number(s.score),
            finalRank: s.final_rank,
            producerHandle: s.producer_handle,
            isSupporter: s.producer_plan === 'paid',
            genreSlug: s.genre_slug,
            createdAt: new Date(s.created_at).toISOString(),
          };
        }),
    );
  }

  return c.json(
    {
      id: playlist.id,
      month: playlist.month,
      title: playlist.title,
      description: playlist.description,
      publishedAt: new Date(playlist.published_at).toISOString(),
      createdAt: new Date(playlist.created_at).toISOString(),
      submissions,
    },
    200,
  );
});

// Needed for Drizzle schema inference
import { genres, submissions, users } from '../db/schema.js';
void genres;
void submissions;
void users;
