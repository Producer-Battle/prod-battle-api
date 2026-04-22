import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { genres, matchPlayers, matchTeams, matches } from '../db/schema.js';
import {
  PRIVATE_SUBMIT_SECONDS_PRESETS,
  SUBMIT_SECONDS_DEFAULT,
} from '../matchmaking/defaults.js';

export const matchesRoutes = new OpenAPIHono();

const MODES = ['quickplay', 'ranked', 'private', 'tournament', 'practice'] as const;
const PRIVATE_PRESETS = PRIVATE_SUBMIT_SECONDS_PRESETS as unknown as [number, ...number[]];

const CreateMatchBody = z
  .object({
    mode: z.enum(MODES),
    genreSlug: z.string().openapi({ example: 'phonk' }),
    // MVP: FFA only — teamSize is always 1 (everyone solo).
    teamSize: z.literal(1).default(1),
    teamCount: z.number().int().min(1).max(8).default(2),
    submitSeconds: z
      .number()
      .int()
      .optional()
      .describe(
        'Submission-phase duration in seconds. Required for private rooms (must be one of the presets). Omit for other modes to use the per-mode default.',
      ),
  })
  .refine((v) => v.teamSize * v.teamCount <= 10, {
    message: 'team_size * team_count must be <= 10',
  })
  .refine((v) => v.mode !== 'practice' || v.teamCount === 1, {
    message: 'practice mode is solo (teamCount must be 1)',
  })
  .refine(
    (v) => v.mode !== 'private' || (v.submitSeconds != null && (PRIVATE_PRESETS as readonly number[]).includes(v.submitSeconds)),
    { message: `Private rooms require submitSeconds ∈ ${JSON.stringify(PRIVATE_SUBMIT_SECONDS_PRESETS)}` },
  )
  .openapi('CreateMatchBody');

const MatchResponse = z
  .object({
    id: z.string().uuid(),
    mode: z.enum(MODES),
    roomCode: z.string(),
    teamSize: z.number().int(),
    teamCount: z.number().int(),
    submitSeconds: z.number().int(),
    genre: z.object({ slug: z.string(), name: z.string() }),
    status: z.string(),
    createdAt: z.string(),
  })
  .openapi('Match');

function randomRoomCode(len = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  let code = '';
  for (let i = 0; i < len; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

const createRouteDef = createRoute({
  method: 'post',
  path: '/matches',
  tags: ['matches'],
  summary: 'Create a match (Quick Play / Ranked / Private room)',
  request: {
    body: {
      content: { 'application/json': { schema: CreateMatchBody } },
    },
  },
  responses: {
    201: {
      description: 'Match created',
      content: { 'application/json': { schema: MatchResponse } },
    },
    400: { description: 'Validation failed' },
    404: { description: 'Genre not found' },
  },
});

matchesRoutes.openapi(createRouteDef, async (c) => {
  const body = c.req.valid('json');
  const d = db();

  const [genre] = await d.select().from(genres).where(eq(genres.slug, body.genreSlug)).limit(1);
  if (!genre) return c.json({ error: 'genre not found' }, 404);

  if ((body.mode === 'quickplay' || body.mode === 'ranked') && genre.kind !== 'system') {
    return c.json({ error: `${body.mode} requires a system genre` }, 400);
  }

  const submitSeconds =
    body.submitSeconds ?? SUBMIT_SECONDS_DEFAULT[body.mode];

  // Find a free room code. Unique constraint will reject collisions; retry a few times.
  let created: typeof matches.$inferSelect | undefined;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    const code = randomRoomCode();
    try {
      const [row] = await d
        .insert(matches)
        .values({
          mode: body.mode,
          status: 'lobby',
          roomCode: code,
          teamSize: body.teamSize,
          teamCount: body.teamCount,
          primaryGenreId: genre.id,
          submitSeconds,
        })
        .returning();
      created = row;
    } catch (err: unknown) {
      // 23505 = unique_violation on room_code; try again.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === '23505'
      ) {
        continue;
      }
      throw err;
    }
  }
  if (!created) return c.json({ error: 'could not allocate room code' }, 500);

  // Seat the teams in advance so WS joiners have slots to map to.
  await d.insert(matchTeams).values(
    Array.from({ length: body.teamCount }, (_, seat) => ({
      matchId: created!.id,
      seat,
      name: String.fromCharCode(65 + seat),
    })),
  );

  return c.json(
    {
      id: created.id,
      mode: created.mode,
      roomCode: created.roomCode!,
      teamSize: created.teamSize,
      teamCount: created.teamCount,
      submitSeconds,
      genre: { slug: genre.slug, name: genre.name },
      status: created.status,
      createdAt: created.createdAt.toISOString(),
    },
    201,
  );
});

const getRouteDef = createRoute({
  method: 'get',
  path: '/matches/{code}',
  tags: ['matches'],
  summary: 'Fetch a match by room code',
  request: {
    params: z.object({ code: z.string() }),
  },
  responses: {
    200: {
      description: 'Match',
      content: { 'application/json': { schema: MatchResponse } },
    },
    404: { description: 'Not found' },
  },
});

matchesRoutes.openapi(getRouteDef, async (c) => {
  const { code } = c.req.valid('param');
  const d = db();
  const [row] = await d
    .select({
      id: matches.id,
      mode: matches.mode,
      roomCode: matches.roomCode,
      teamSize: matches.teamSize,
      teamCount: matches.teamCount,
      submitSeconds: matches.submitSeconds,
      status: matches.status,
      createdAt: matches.createdAt,
      genreSlug: genres.slug,
      genreName: genres.name,
    })
    .from(matches)
    .innerJoin(genres, eq(genres.id, matches.primaryGenreId))
    .where(eq(matches.roomCode, code))
    .limit(1);

  if (!row || !row.roomCode) return c.json({ error: 'not found' }, 404);
  return c.json({
    id: row.id,
    mode: row.mode,
    roomCode: row.roomCode,
    teamSize: row.teamSize,
    teamCount: row.teamCount,
    submitSeconds: row.submitSeconds ?? SUBMIT_SECONDS_DEFAULT[row.mode],
    genre: { slug: row.genreSlug, name: row.genreName },
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  });
});
