// A&R dashboard endpoints.
//
// Open to role in ('ar', 'admin'). Surfaces:
//   - top producers by recent voted performance
//   - detailed producer profile view
//   - a feed of recently-finished battles worth listening to
//   - watchlist (CRUD) for AR scouts

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { signUrl } from '../audio/s3.js';
import { db } from '../db/client.js';

export const arRoutes = new OpenAPIHono();

const ArError = z.object({ error: z.string(), message: z.string() });

const requireAr = (
  c: Parameters<Parameters<typeof arRoutes.openapi>[1]>[0],
):
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; body: { error: string; message: string } } => {
  const user = c.var.user;
  if (!user)
    return { ok: false, status: 401, body: { error: 'unauthenticated', message: 'Sign in.' } };
  if (user.role !== 'ar' && user.role !== 'admin')
    return {
      ok: false,
      status: 403,
      body: { error: 'forbidden', message: 'A&R or admin role required.' },
    };
  return { ok: true, userId: user.id };
};

// ─── GET /ar/producers ───────────────────────────────────────────────────────

const topProducersRoute = createRoute({
  method: 'get',
  path: '/ar/producers',
  tags: ['ar'],
  summary: 'Top producers by recent performance',
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      genreSlug: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Producers',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(
              z.object({
                userId: z.string().uuid(),
                handle: z.string(),
                avatarUrl: z.string().nullable(),
                matchesPlayed: z.number().int(),
                wins: z.number().int(),
                totalSubmissionScore: z.number(),
              }),
            ),
          }),
        },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ArError } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ArError } } },
  },
});

arRoutes.openapi(topProducersRoute, async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { limit, genreSlug } = c.req.valid('query');
  const d = db();

  // A "win" = finalRank === 1 on the submission. totalSubmissionScore sums
  // the numeric score each submission accumulated (votes × weight, already
  // rolled up by the match-results step).
  const rows = await d.execute<{
    user_id: string;
    handle: string;
    avatar_url: string | null;
    matches_played: string;
    wins: string;
    total_score: string;
  }>(sql`
    SELECT u.id AS user_id,
           u.handle,
           u.avatar_url,
           COUNT(DISTINCT s.match_id)::text          AS matches_played,
           COUNT(*) FILTER (WHERE s.final_rank = 1)::text AS wins,
           COALESCE(SUM(s.score), 0)::text           AS total_score
      FROM users u
      JOIN submissions s ON s.user_id = u.id
      JOIN genres g ON g.id = s.genre_id
     WHERE u.role IN ('producer')
       AND (${genreSlug ?? null}::text IS NULL OR g.slug = ${genreSlug ?? null})
     GROUP BY u.id, u.handle, u.avatar_url
     HAVING COUNT(DISTINCT s.match_id) > 0
     ORDER BY total_score DESC, wins DESC
     LIMIT ${limit}
  `);

  return c.json(
    {
      items: rows.map((r) => ({
        userId: r.user_id,
        handle: r.handle,
        avatarUrl: r.avatar_url,
        matchesPlayed: Number(r.matches_played),
        wins: Number(r.wins),
        totalSubmissionScore: Number(r.total_score),
      })),
    },
    200,
  );
});

// ─── GET /ar/battles/recent ─────────────────────────────────────────────────

const recentBattlesRoute = createRoute({
  method: 'get',
  path: '/ar/battles/recent',
  tags: ['ar'],
  summary: 'Recently-finished battles, newest first',
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      genreSlug: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Battles',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(
              z.object({
                matchId: z.string().uuid(),
                genreSlug: z.string(),
                genreName: z.string(),
                endedAt: z.string().datetime(),
                submissions: z.array(
                  z.object({
                    submissionId: z.string().uuid(),
                    userHandle: z.string(),
                    finalRank: z.number().int().nullable(),
                    score: z.number(),
                    audioUrl: z.string(),
                  }),
                ),
              }),
            ),
          }),
        },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ArError } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ArError } } },
  },
});

arRoutes.openapi(recentBattlesRoute, async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { limit, genreSlug } = c.req.valid('query');
  const d = db();

  type Row = {
    match_id: string;
    genre_slug: string;
    genre_name: string;
    ended_at: string;
    submission_id: string;
    user_handle: string;
    final_rank: number | null;
    score: string;
    audio_url: string;
  };
  const rows = await d.execute<Row>(sql`
    SELECT m.id AS match_id,
           g.slug AS genre_slug,
           g.name AS genre_name,
           m.ended_at,
           s.id AS submission_id,
           u.handle AS user_handle,
           s.final_rank,
           s.score::text AS score,
           s.audio_url
      FROM matches m
      JOIN genres g ON g.id = m.primary_genre_id
      JOIN submissions s ON s.match_id = m.id
      JOIN users u ON u.id = s.user_id
     WHERE m.status = 'results'
       AND m.ended_at IS NOT NULL
       AND (${genreSlug ?? null}::text IS NULL OR g.slug = ${genreSlug ?? null})
     ORDER BY m.ended_at DESC, s.final_rank ASC NULLS LAST
     LIMIT ${limit * 10}
  `);

  // Fold submissions under their match, preserving ended_at ordering.
  const byMatch = new Map<
    string,
    {
      matchId: string;
      genreSlug: string;
      genreName: string;
      endedAt: string;
      submissions: {
        submissionId: string;
        userHandle: string;
        finalRank: number | null;
        score: number;
        audioUrl: string;
      }[];
    }
  >();

  for (const r of rows) {
    let entry = byMatch.get(r.match_id);
    if (!entry) {
      entry = {
        matchId: r.match_id,
        genreSlug: r.genre_slug,
        genreName: r.genre_name,
        endedAt: new Date(r.ended_at).toISOString(),
        submissions: [],
      };
      byMatch.set(r.match_id, entry);
    }
    entry.submissions.push({
      submissionId: r.submission_id,
      userHandle: r.user_handle,
      finalRank: r.final_rank,
      score: Number(r.score),
      audioUrl: r.audio_url,
    });
  }

  const items = Array.from(byMatch.values()).slice(0, limit);
  return c.json({ items }, 200);
});

// ─── GET /ar/producers/:producerId ──────────────────────────────────────────

const producerDetailRoute = createRoute({
  method: 'get',
  path: '/ar/producers/:producerId',
  tags: ['ar'],
  summary: 'Full profile of one producer for an A&R scout',
  request: {
    params: z.object({ producerId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Producer detail',
      content: {
        'application/json': {
          schema: z.object({
            userId: z.string().uuid(),
            handle: z.string(),
            avatarUrl: z.string().nullable(),
            bio: z.string().nullable(),
            location: z.string().nullable(),
            openToAr: z.boolean(),
            socialLinks: z.record(z.string()),
            honor: z.number().int(),
            plan: z.enum(['free', 'paid']),
            stats: z.object({
              matchesPlayed: z.number().int(),
              wins: z.number().int(),
              totalSubmissionScore: z.number(),
              topGenres: z.array(
                z.object({
                  slug: z.string(),
                  name: z.string(),
                  score: z.number(),
                  wins: z.number().int(),
                }),
              ),
            }),
            topTracks: z.array(
              z.object({
                submissionId: z.string().uuid(),
                audioUrl: z.string(),
                waveformUrl: z.string().nullable(),
                score: z.number(),
                finalRank: z.number().int().nullable(),
                genreSlug: z.string(),
                genreName: z.string(),
                matchId: z.string().uuid(),
                submittedAt: z.string().datetime(),
              }),
            ),
            uploadedPacks: z.array(
              z.object({
                id: z.string().uuid(),
                name: z.string(),
                genreSlug: z.string(),
                genreName: z.string(),
                createdAt: z.string().datetime(),
                samplesPreview: z.array(
                  z.object({
                    stemType: z.string(),
                    name: z.string(),
                    url: z.string(),
                  }),
                ),
                zipUrl: z.string().nullable(),
              }),
            ),
          }),
        },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ArError } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ArError } } },
    404: { description: 'Not found', content: { 'application/json': { schema: ArError } } },
  },
});

arRoutes.openapi(producerDetailRoute, async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { producerId } = c.req.valid('param');
  const d = db();

  // Profile + producer_profiles
  type ProfileRow = {
    user_id: string;
    handle: string;
    avatar_url: string | null;
    honor: number;
    plan: string;
    bio: string | null;
    location: string | null;
    open_to_ar: boolean;
    social_links: Record<string, string>;
    role: string;
  };
  const [profile] = await d.execute<ProfileRow>(sql`
    SELECT u.id AS user_id,
           u.handle,
           u.avatar_url,
           u.honor,
           u.plan,
           u.role,
           pp.bio,
           pp.location,
           COALESCE(pp.open_to_ar, true) AS open_to_ar,
           COALESCE(pp.social_links, '{}'::jsonb) AS social_links
      FROM users u
      LEFT JOIN producer_profiles pp ON pp.user_id = u.id
     WHERE u.id = ${producerId}
       AND u.role IN ('producer')
       AND u.status = 'active'
     LIMIT 1
  `);

  if (!profile) {
    return c.json({ error: 'not_found', message: 'Producer not found.' }, 404);
  }

  // Aggregate stats + top genres
  type StatsRow = {
    matches_played: string;
    wins: string;
    total_score: string;
  };
  const [stats] = await d.execute<StatsRow>(sql`
    SELECT COUNT(DISTINCT s.match_id)::text AS matches_played,
           COUNT(*) FILTER (WHERE s.final_rank = 1)::text AS wins,
           COALESCE(SUM(s.score), 0)::text AS total_score
      FROM submissions s
     WHERE s.user_id = ${producerId}
  `);

  type GenreRow = {
    slug: string;
    name: string;
    score: string;
    wins: string;
  };
  const topGenres = await d.execute<GenreRow>(sql`
    SELECT g.slug,
           g.name,
           COALESCE(SUM(s.score), 0)::text AS score,
           COUNT(*) FILTER (WHERE s.final_rank = 1)::text AS wins
      FROM submissions s
      JOIN genres g ON g.id = s.genre_id
     WHERE s.user_id = ${producerId}
     GROUP BY g.id, g.slug, g.name
     ORDER BY score DESC
     LIMIT 3
  `);

  // Top 8 tracks
  type TrackRow = {
    submission_id: string;
    audio_url: string;
    waveform_url: string | null;
    score: string;
    final_rank: number | null;
    genre_slug: string;
    genre_name: string;
    match_id: string;
    submitted_at: string;
  };
  const trackRows = await d.execute<TrackRow>(sql`
    SELECT s.id AS submission_id,
           s.audio_url,
           s.waveform_url,
           s.score::text AS score,
           s.final_rank,
           g.slug AS genre_slug,
           g.name AS genre_name,
           s.match_id,
           s.created_at AS submitted_at
      FROM submissions s
      JOIN genres g ON g.id = s.genre_id
     WHERE s.user_id = ${producerId}
     ORDER BY s.score DESC
     LIMIT 8
  `);

  // Uploaded packs
  type PackRow = {
    id: string;
    name: string;
    genre_slug: string;
    genre_name: string;
    created_at: string;
    samples: Array<{ stemType: string; name: string; url: string }>;
    zip_url: string | null;
  };
  const packRows = await d.execute<PackRow>(sql`
    SELECT sp.id,
           sp.name,
           g.slug AS genre_slug,
           g.name AS genre_name,
           sp.created_at,
           sp.samples,
           sp.zip_url
      FROM sample_packs sp
      JOIN genres g ON g.id = sp.genre_id
     WHERE sp.created_by = ${producerId}
       AND sp.kind = 'uploaded'
     ORDER BY sp.created_at DESC
  `);

  // Sign all audio URLs
  const signedTracks = await Promise.all(
    trackRows.map(async (t) => ({
      submissionId: t.submission_id,
      audioUrl: await signUrl(t.audio_url),
      waveformUrl: t.waveform_url ? await signUrl(t.waveform_url) : null,
      score: Number(t.score),
      finalRank: t.final_rank,
      genreSlug: t.genre_slug,
      genreName: t.genre_name,
      matchId: t.match_id,
      submittedAt: new Date(t.submitted_at).toISOString(),
    })),
  );

  const signedPacks = await Promise.all(
    packRows.map(async (p) => {
      const samplesArray = Array.isArray(p.samples) ? p.samples : [];
      const preview = samplesArray.slice(0, 3);
      const signedPreview = await Promise.all(
        preview.map(async (s) => ({
          stemType: s.stemType,
          name: s.name,
          url: await signUrl(s.url),
        })),
      );
      return {
        id: p.id,
        name: p.name,
        genreSlug: p.genre_slug,
        genreName: p.genre_name,
        createdAt: new Date(p.created_at).toISOString(),
        samplesPreview: signedPreview,
        zipUrl: p.zip_url ? await signUrl(p.zip_url) : null,
      };
    }),
  );

  return c.json(
    {
      userId: profile.user_id,
      handle: profile.handle,
      avatarUrl: profile.avatar_url,
      bio: profile.bio,
      location: profile.location,
      openToAr: profile.open_to_ar,
      socialLinks: (profile.social_links as Record<string, string>) ?? {},
      honor: profile.honor,
      plan: profile.plan as 'free' | 'paid',
      stats: {
        matchesPlayed: Number(stats?.matches_played ?? 0),
        wins: Number(stats?.wins ?? 0),
        totalSubmissionScore: Number(stats?.total_score ?? 0),
        topGenres: topGenres.map((g) => ({
          slug: g.slug,
          name: g.name,
          score: Number(g.score),
          wins: Number(g.wins),
        })),
      },
      topTracks: signedTracks,
      uploadedPacks: signedPacks,
    },
    200,
  );
});

// ─── GET /ar/watchlist ──────────────────────────────────────────────────────

const watchlistGetRoute = createRoute({
  method: 'get',
  path: '/ar/watchlist',
  tags: ['ar'],
  summary: 'The calling AR scout watchlist, sorted by addedAt DESC',
  responses: {
    200: {
      description: 'Watchlist',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(
              z.object({
                producerId: z.string().uuid(),
                handle: z.string(),
                avatarUrl: z.string().nullable(),
                note: z.string().nullable(),
                addedAt: z.string().datetime(),
                totalSubmissionScore: z.number(),
                wins: z.number().int(),
              }),
            ),
          }),
        },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ArError } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ArError } } },
  },
});

arRoutes.openapi(watchlistGetRoute, async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);

  const d = db();

  type WatchRow = {
    producer_id: string;
    handle: string;
    avatar_url: string | null;
    note: string | null;
    added_at: string;
    total_score: string;
    wins: string;
  };

  const rows = await d.execute<WatchRow>(sql`
    SELECT w.producer_id,
           u.handle,
           u.avatar_url,
           w.note,
           w.added_at,
           COALESCE(SUM(s.score), 0)::text AS total_score,
           COUNT(*) FILTER (WHERE s.final_rank = 1)::text AS wins
      FROM ar_watchlist w
      JOIN users u ON u.id = w.producer_id
      LEFT JOIN submissions s ON s.user_id = w.producer_id
     WHERE w.ar_user_id = ${g.userId}
     GROUP BY w.producer_id, u.handle, u.avatar_url, w.note, w.added_at
     ORDER BY w.added_at DESC
  `);

  return c.json(
    {
      items: rows.map((r) => ({
        producerId: r.producer_id,
        handle: r.handle,
        avatarUrl: r.avatar_url,
        note: r.note,
        addedAt: new Date(r.added_at).toISOString(),
        totalSubmissionScore: Number(r.total_score),
        wins: Number(r.wins),
      })),
    },
    200,
  );
});

// ─── PUT /ar/watchlist/:producerId ──────────────────────────────────────────

const watchlistPutRoute = createRoute({
  method: 'put',
  path: '/ar/watchlist/:producerId',
  tags: ['ar'],
  summary: 'Add or update a producer on the watchlist',
  request: {
    params: z.object({ producerId: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ note: z.string().optional() }),
        },
      },
      required: false,
    },
  },
  responses: {
    200: {
      description: 'Upserted',
      content: {
        'application/json': {
          schema: z.object({
            producerId: z.string().uuid(),
            note: z.string().nullable(),
            addedAt: z.string().datetime(),
          }),
        },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ArError } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ArError } } },
    404: {
      description: 'Producer not found',
      content: { 'application/json': { schema: ArError } },
    },
  },
});

arRoutes.openapi(watchlistPutRoute, async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { producerId } = c.req.valid('param');
  const body = (await c.req.json().catch(() => ({}))) as { note?: string };
  const note = body?.note ?? null;

  const d = db();

  // Verify the target user exists
  type ExistsRow = { exists: boolean };
  const [exists] = await d.execute<ExistsRow>(sql`
    SELECT EXISTS (SELECT 1 FROM users WHERE id = ${producerId} AND status = 'active') AS exists
  `);
  if (!exists?.exists) {
    return c.json({ error: 'not_found', message: 'Producer not found.' }, 404);
  }

  type UpsertRow = { producer_id: string; note: string | null; added_at: string };
  const upsertRows = await d.execute<UpsertRow>(sql`
    INSERT INTO ar_watchlist (ar_user_id, producer_id, note, added_at)
    VALUES (${g.userId}, ${producerId}, ${note}, now())
    ON CONFLICT (ar_user_id, producer_id) DO UPDATE
      SET note = EXCLUDED.note
    RETURNING producer_id, note, added_at
  `);
  const row = upsertRows[0];
  if (!row) {
    return c.json({ error: 'server_error', message: 'Upsert failed.' }, 500 as never);
  }

  return c.json(
    {
      producerId: row.producer_id,
      note: row.note,
      addedAt: new Date(row.added_at).toISOString(),
    },
    200,
  );
});

// ─── DELETE /ar/watchlist/:producerId ───────────────────────────────────────

const watchlistDeleteRoute = createRoute({
  method: 'delete',
  path: '/ar/watchlist/:producerId',
  tags: ['ar'],
  summary: 'Remove a producer from the watchlist (idempotent)',
  request: {
    params: z.object({ producerId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Removed',
      content: {
        'application/json': {
          schema: z.object({ removed: z.literal(true) }),
        },
      },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ArError } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ArError } } },
  },
});

arRoutes.openapi(watchlistDeleteRoute, async (c) => {
  const g = requireAr(c);
  if (!g.ok) return c.json(g.body, g.status);

  const { producerId } = c.req.valid('param');
  const d = db();

  await d.execute(sql`
    DELETE FROM ar_watchlist
     WHERE ar_user_id = ${g.userId}
       AND producer_id = ${producerId}
  `);

  return c.json({ removed: true as const }, 200);
});
