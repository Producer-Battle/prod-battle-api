// Tournament scheduling endpoints. Lets users browse upcoming
// tournaments, register, and admins create them. The actual bracket
// pairing happens in src/realtime/tick.ts tournamentScheduleScan.
//
// Routes:
//   GET   /tournaments/upcoming                  list open + starting tournaments
//   GET   /tournaments/{id}                      tournament detail + entrants + matches
//   POST  /tournaments                           admin: create
//   POST  /tournaments/{id}/register             user: enter
//   DELETE /tournaments/{id}/register            user: withdraw before lock

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { genres, matches, tournamentEntries, tournaments, users } from '../db/schema.js';
import { getCategory } from '../game-rules/loader.js';

export const tournamentScheduleRoutes = new OpenAPIHono();

const ErrorBody = z.object({ error: z.string(), message: z.string() });

const TournamentSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  genreSlug: z.string(),
  genreName: z.string(),
  startsAt: z.string().datetime(),
  registrationClosesAt: z.string().datetime(),
  status: z.enum(['open', 'starting', 'in_progress', 'finished', 'cancelled']),
  maxEntrants: z.number().int(),
  entrantCount: z.number().int(),
  registered: z.boolean(),
});

const TournamentMatch = z.object({
  matchId: z.string().uuid(),
  roomCode: z.string(),
  round: z.number().int(),
  status: z.string(),
  players: z.array(z.string()),
  winner: z.string().nullable(),
});

const TournamentDetail = TournamentSummary.extend({
  entrants: z.array(z.object({ handle: z.string() })),
  bracket: z.array(TournamentMatch),
  winnerHandle: z.string().nullable(),
});

// ─── GET /tournaments/upcoming ─────────────────────────────────────────────

const upcomingRoute = createRoute({
  method: 'get',
  path: '/tournaments/upcoming',
  tags: ['tournaments'],
  summary: 'Tournaments accepting entrants or starting soon',
  responses: {
    200: {
      description: 'Upcoming tournaments',
      content: {
        'application/json': { schema: z.object({ items: z.array(TournamentSummary) }) },
      },
    },
  },
});

tournamentScheduleRoutes.openapi(upcomingRoute, async (c) => {
  const callerId = c.var.user?.id ?? null;
  const rows = await db().execute<{
    id: string;
    name: string;
    genre_slug: string;
    genre_name: string;
    starts_at: Date | string;
    registration_closes_at: Date | string;
    status: string;
    max_entrants: number;
    entrant_count: string;
    is_registered: boolean;
  }>(
    sql`SELECT t.id, t.name, g.slug AS genre_slug, g.name AS genre_name,
               t.starts_at, t.registration_closes_at, t.status, t.max_entrants,
               (SELECT COUNT(*)::text FROM tournament_entries te WHERE te.tournament_id = t.id) AS entrant_count,
               (${callerId ? sql`EXISTS (SELECT 1 FROM tournament_entries te2 WHERE te2.tournament_id = t.id AND te2.user_id = ${callerId})` : sql`FALSE`}) AS is_registered
          FROM tournaments t
          JOIN genres g ON g.id = t.genre_id
         WHERE t.status IN ('open', 'starting', 'in_progress')
         ORDER BY t.starts_at ASC
         LIMIT 50`,
  );
  const arr = rows as Array<{
    id: string;
    name: string;
    genre_slug: string;
    genre_name: string;
    starts_at: Date | string;
    registration_closes_at: Date | string;
    status: string;
    max_entrants: number;
    entrant_count: string;
    is_registered: boolean;
  }>;
  return c.json(
    {
      items: arr.map((r) => ({
        id: r.id,
        name: r.name,
        genreSlug: r.genre_slug,
        genreName: r.genre_name,
        startsAt: new Date(r.starts_at).toISOString(),
        registrationClosesAt: new Date(r.registration_closes_at).toISOString(),
        status: r.status as 'open' | 'starting' | 'in_progress' | 'finished' | 'cancelled',
        maxEntrants: Number(r.max_entrants),
        entrantCount: Number(r.entrant_count),
        registered: !!r.is_registered,
      })),
    },
    200,
  );
});

// ─── GET /tournaments/:id ──────────────────────────────────────────────────

const detailRoute = createRoute({
  method: 'get',
  path: '/tournaments/{id}',
  tags: ['tournaments'],
  summary: 'Tournament detail with entrants and bracket',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Detail',
      content: { 'application/json': { schema: TournamentDetail } },
    },
    404: { description: 'Not found', content: { 'application/json': { schema: ErrorBody } } },
  },
});

tournamentScheduleRoutes.openapi(detailRoute, async (c) => {
  const { id } = c.req.valid('param');
  const callerId = c.var.user?.id ?? null;
  const d = db();

  const [t] = await d
    .select({
      id: tournaments.id,
      name: tournaments.name,
      genreId: tournaments.genreId,
      startsAt: tournaments.startsAt,
      registrationClosesAt: tournaments.registrationClosesAt,
      status: tournaments.status,
      maxEntrants: tournaments.maxEntrants,
      winnerId: tournaments.winnerId,
    })
    .from(tournaments)
    .where(eq(tournaments.id, id))
    .limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'No such tournament.' }, 404);

  const [g] = await d
    .select({ slug: genres.slug, name: genres.name })
    .from(genres)
    .where(eq(genres.id, t.genreId))
    .limit(1);

  const entrantsRows = await d.execute<{ handle: string; user_id: string }>(
    sql`SELECT u.handle, u.id AS user_id
          FROM tournament_entries te
          JOIN users u ON u.id = te.user_id
         WHERE te.tournament_id = ${id}
         ORDER BY te.registered_at ASC`,
  );
  const entrants = entrantsRows as Array<{ handle: string; user_id: string }>;

  const bracketRows = await d.execute<{
    match_id: string;
    room_code: string;
    round: number;
    status: string;
    players: string[];
    winner_handle: string | null;
  }>(
    sql`SELECT m.id AS match_id, m.room_code, m.tournament_round AS round, m.status,
               (SELECT array_agg(u.handle ORDER BY u.handle)
                  FROM match_players mp JOIN users u ON u.id = mp.user_id
                 WHERE mp.match_id = m.id AND mp.is_spectator = false) AS players,
               (SELECT u.handle FROM submissions s JOIN users u ON u.id = s.user_id
                 WHERE s.match_id = m.id AND s.final_rank = 1 LIMIT 1) AS winner_handle
          FROM matches m
         WHERE m.tournament_id = ${id}
         ORDER BY m.tournament_round ASC, m.created_at ASC`,
  );
  const bracket = bracketRows as Array<{
    match_id: string;
    room_code: string;
    round: number;
    status: string;
    players: string[] | null;
    winner_handle: string | null;
  }>;

  const winnerHandle = t.winnerId
    ? ((await d.execute<{ handle: string }>(
        sql`SELECT handle FROM users WHERE id = ${t.winnerId} LIMIT 1`,
      )) as Array<{ handle: string }>)
    : null;

  const isRegistered = callerId ? entrants.some((e) => e.user_id === callerId) : false;

  return c.json(
    {
      id: t.id,
      name: t.name,
      genreSlug: g?.slug ?? '',
      genreName: g?.name ?? '',
      startsAt: t.startsAt.toISOString(),
      registrationClosesAt: t.registrationClosesAt.toISOString(),
      status: t.status as 'open' | 'starting' | 'in_progress' | 'finished' | 'cancelled',
      maxEntrants: t.maxEntrants,
      entrantCount: entrants.length,
      registered: isRegistered,
      entrants: entrants.map((e) => ({ handle: e.handle })),
      bracket: bracket.map((b) => ({
        matchId: b.match_id,
        roomCode: b.room_code,
        round: Number(b.round),
        status: b.status,
        players: b.players ?? [],
        winner: b.winner_handle,
      })),
      winnerHandle: winnerHandle?.[0]?.handle ?? null,
    },
    200,
  );
});

// ─── POST /tournaments (admin) ─────────────────────────────────────────────

const createBody = z.object({
  name: z.string().min(3).max(80),
  genreSlug: z.string(),
  startsAt: z.string().datetime(),
  registrationClosesAt: z.string().datetime(),
  maxEntrants: z.number().int().min(2).max(64).optional().default(16),
});

const createRouteDef = createRoute({
  method: 'post',
  path: '/tournaments',
  tags: ['tournaments'],
  summary: 'Schedule a new tournament (admin only)',
  request: { body: { content: { 'application/json': { schema: createBody } } } },
  responses: {
    201: {
      description: 'Created',
      content: { 'application/json': { schema: z.object({ id: z.string().uuid() }) } },
    },
    400: { description: 'Bad request', content: { 'application/json': { schema: ErrorBody } } },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorBody } } },
    403: { description: 'Not an admin', content: { 'application/json': { schema: ErrorBody } } },
  },
});

tournamentScheduleRoutes.openapi(createRouteDef, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);
  if (user.role !== 'admin')
    return c.json({ error: 'forbidden', message: 'Admin role required.' }, 403);

  const body = c.req.valid('json');
  const d = db();
  const [g] = await d.select().from(genres).where(eq(genres.slug, body.genreSlug)).limit(1);
  if (!g) return c.json({ error: 'no_genre', message: 'Unknown genre slug.' }, 400);

  const startsAtDate = new Date(body.startsAt);
  const closesAtDate = new Date(body.registrationClosesAt);
  if (closesAtDate >= startsAtDate)
    return c.json(
      { error: 'bad_window', message: 'registrationClosesAt must be before startsAt.' },
      400,
    );

  const [row] = await d
    .insert(tournaments)
    .values({
      name: body.name,
      genreId: g.id,
      startsAt: startsAtDate,
      registrationClosesAt: closesAtDate,
      maxEntrants: body.maxEntrants,
      createdBy: user.id,
    })
    .returning({ id: tournaments.id });
  if (!row) return c.json({ error: 'create_failed', message: 'Could not create.' }, 400);
  return c.json({ id: row.id }, 201);
});

// ─── POST /tournaments/:id/register ────────────────────────────────────────

const registerRoute = createRoute({
  method: 'post',
  path: '/tournaments/{id}/register',
  tags: ['tournaments'],
  summary: 'Register the authenticated user for a tournament',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    201: {
      description: 'Registered',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    400: {
      description: 'Tournament closed or full',
      content: { 'application/json': { schema: ErrorBody } },
    },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorBody } } },
    403: { description: 'Honor too low', content: { 'application/json': { schema: ErrorBody } } },
    404: {
      description: 'Tournament not found',
      content: { 'application/json': { schema: ErrorBody } },
    },
  },
});

tournamentScheduleRoutes.openapi(registerRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);

  const { id } = c.req.valid('param');
  const d = db();

  const honorRules = await getCategory('honor');
  const [u] = await d
    .select({ honor: users.honor })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if ((u?.honor ?? 100) < honorRules.gates.tournament) {
    return c.json(
      {
        error: 'low_honor',
        message: `Honor too low for tournaments (need ${honorRules.gates.tournament}, have ${u?.honor ?? 100}).`,
      },
      403,
    );
  }

  const [t] = await d.select().from(tournaments).where(eq(tournaments.id, id)).limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'No such tournament.' }, 404);
  if (t.status !== 'open')
    return c.json({ error: 'closed', message: 'Registration is closed.' }, 400);
  if (new Date(t.registrationClosesAt) < new Date())
    return c.json({ error: 'closed', message: 'Registration window has ended.' }, 400);

  const [count] = await d.execute<{ n: string }>(
    sql`SELECT COUNT(*)::text AS n FROM tournament_entries WHERE tournament_id = ${id}`,
  );
  if (Number((count as { n: string } | undefined)?.n ?? 0) >= t.maxEntrants)
    return c.json({ error: 'full', message: 'Tournament is full.' }, 400);

  await d
    .insert(tournamentEntries)
    .values({ tournamentId: id, userId: user.id })
    .onConflictDoNothing();
  return c.json({ ok: true as const }, 201);
});

// ─── DELETE /tournaments/:id/register (withdraw before lock) ───────────────

const withdrawRoute = createRoute({
  method: 'delete',
  path: '/tournaments/{id}/register',
  tags: ['tournaments'],
  summary: 'Withdraw registration before the lock',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Withdrawn',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    400: { description: 'Already started', content: { 'application/json': { schema: ErrorBody } } },
    401: { description: 'Unauthenticated', content: { 'application/json': { schema: ErrorBody } } },
  },
});

tournamentScheduleRoutes.openapi(withdrawRoute, async (c) => {
  const user = c.var.user;
  if (!user) return c.json({ error: 'unauthenticated', message: 'Sign in.' }, 401);

  const { id } = c.req.valid('param');
  const d = db();

  const [t] = await d.select().from(tournaments).where(eq(tournaments.id, id)).limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'No such tournament.' }, 400);
  if (t.status !== 'open')
    return c.json({ error: 'started', message: 'Cannot withdraw after registration closes.' }, 400);

  await d
    .delete(tournamentEntries)
    .where(and(eq(tournamentEntries.tournamentId, id), eq(tournamentEntries.userId, user.id)));
  return c.json({ ok: true as const }, 200);
});

// `desc`/`gt` consumed by future paginated views; keep in scope.
void desc;
void gt;
