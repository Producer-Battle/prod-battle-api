import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { signUrl } from '../audio/s3.js';
import { db } from '../db/client.js';
import {
  flipSources,
  genres,
  matchPlayers,
  matchTeams,
  matches,
  packPlays,
  samplePacks,
  submissions,
  users,
} from '../db/schema.js';
import { generateMatchPack } from '../genres/generate.js';
import {
  DEFAULT_SAMPLE_MODE,
  PRIVATE_SUBMIT_SECONDS_PRESETS,
  SUBMIT_SECONDS_DEFAULT,
} from '../matchmaking/defaults.js';
import { requireMatchQuota, requireProducerQuota } from '../middleware/rate-limit.js';

export const matchesRoutes = new OpenAPIHono();

// Apply the anonymous match-creation quota first, then the per-producer
// daily quota for authenticated users.
matchesRoutes.use('/matches', requireMatchQuota());
matchesRoutes.use('/matches', requireProducerQuota('match'));

// POST /matches rejects 'daily' - daily matches are server-created only via GET /daily-challenge.
const MODES = ['quickplay', 'ranked', 'private', 'tournament', 'practice', 'flip'] as const;
const ALL_MODES = [...MODES, 'daily'] as const;
const PRIVATE_PRESETS = PRIVATE_SUBMIT_SECONDS_PRESETS as unknown as [number, ...number[]];

const SamplePackItemSchema = z.object({
  stemType: z.string(),
  name: z.string(),
  url: z.string(),
});

const SamplePackSchema = z
  .object({
    id: z.string().uuid(),
    samples: z.array(SamplePackItemSchema),
  })
  .openapi('SamplePack');

const CreateMatchBody = z
  .object({
    mode: z.enum(MODES),
    // Required for private + practice. Optional for quickplay/ranked/flip
    // - if omitted the server picks a random system genre when creating a
    // new lobby (matchmaking prefers joining any open lobby regardless of
    // genre).
    genreSlug: z.string().optional().openapi({ example: 'phonk' }),
    // MVP: FFA only - teamSize is always 1 (everyone solo).
    teamSize: z.literal(1).default(1),
    teamCount: z.number().int().min(1).max(8).default(2),
    submitSeconds: z
      .number()
      .int()
      .optional()
      .describe(
        'Submission-phase duration in seconds. Required for private rooms (must be one of the presets). Omit for other modes to use the per-mode default.',
      ),
    // Optional Sample Flip source override. When null/missing the server
    // picks a random active flip source (filtered by genre if present).
    flipSourceId: z.string().uuid().optional(),
    // Optional sample-pack override. When provided, that pack is attached
    // to the match instead of a random one. Validation rules:
    //   - kind='pool' packs are open to anyone
    //   - kind='uploaded' packs only usable by their createdBy owner
    // The pack's genre must match body.genreSlug (or the resolved genre).
    samplePackId: z.string().uuid().optional(),
    // Whether this match shows up in GET /lobbies. Only meaningful for
    // private mode (other modes are public-by-default and ignore this).
    // Defaults to false so private rooms stay invite-only unless the host
    // ticks the "List publicly" box.
    isPublic: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.mode === 'quickplay' ||
      v.mode === 'ranked' ||
      v.mode === 'flip' ||
      typeof v.genreSlug === 'string',
    {
      message: 'genreSlug is required for private, tournament, and practice modes',
    },
  )
  .refine((v) => v.teamSize * v.teamCount <= 10, {
    message: 'team_size * team_count must be <= 10',
  })
  .refine((v) => v.mode !== 'practice' || v.teamCount === 1, {
    message: 'practice mode is solo (teamCount must be 1)',
  })
  .refine(
    (v) =>
      v.mode !== 'private' ||
      (v.submitSeconds != null && (PRIVATE_PRESETS as readonly number[]).includes(v.submitSeconds)),
    {
      message: `Private rooms require submitSeconds ∈ ${JSON.stringify(PRIVATE_SUBMIT_SECONDS_PRESETS)}`,
    },
  )
  .openapi('CreateMatchBody');

const FlipSourceSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string(),
    url: z.string().url(),
    durationSec: z.number().int().nullable(),
  })
  .openapi('FlipSource');

const MatchResponse = z
  .object({
    id: z.string().uuid(),
    mode: z.enum(ALL_MODES),
    roomCode: z.string(),
    teamSize: z.number().int(),
    teamCount: z.number().int(),
    submitSeconds: z.number().int(),
    genre: z.object({ slug: z.string(), name: z.string() }),
    status: z.string(),
    createdAt: z.string(),
    samplePack: SamplePackSchema.nullable().optional(),
    // Populated when mode='flip' - the single loop the room is flipping.
    flipSource: FlipSourceSchema.nullable().optional(),
    // Phase info for client re-hydration on refresh. Present once a
    // battle_phases row exists (i.e. match has left the lobby).
    currentPhase: z.string().nullable(),
    transitionsAt: z.number().int().nullable(),
    // When the auto-start countdown will fire (lobby phase only). The
    // tick orchestrator schedules this once seated >= 3 in qp/ranked/flip
    // and force-advances when it expires. Null = not scheduled (waiting
    // for more players, or a mode that does not auto-fire).
    lobbyStartsAt: z.string().nullable(),
    // Did everyone vote on (almost) every entry? Set when the match leaves
    // vote phase. Null until results entry. Used for the "partial tally"
    // pill on the Results UI; does not gate ranked LP updates.
    voteOutcome: z.enum(['complete', 'incomplete']).nullable(),
    voteStats: z.object({
      seated: z.number().int(),
      voted: z.number().int(),
      fullVoted: z.number().int(),
    }),
    // The caller's existing submission for this match, if any. Populated
    // when the request is authenticated (session cookie) OR includes
    // ?user=<handle> for guest passthrough. Lets the Submit screen
    // render the "already submitted" state on a fresh device or after
    // a refresh - the server-side double-submit guard exists either
    // way, this just keeps the UI honest with what's already in the DB.
    mySubmission: z
      .object({
        id: z.string().uuid(),
        audioUrl: z.string().url(),
        title: z.string().nullable(),
        durationSec: z.number().int().nullable(),
      })
      .nullable(),
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

  // Daily matches are server-created only. Clients must use GET /daily-challenge.
  if ((body.mode as string) === 'daily') {
    return c.json({ error: 'daily matches cannot be created via POST /matches' }, 400);
  }

  // Ranked match creation requires a registered account so the Glicko
  // ladder stays meaningful (anonymous visitors don't have a stable user
  // id to score against). Any signed-up user - free or paid - can create.
  // Anonymous get 401 with a sign-in nudge.
  if (body.mode === 'ranked' && !c.var.user) {
    return c.json(
      {
        error: 'ranked_requires_signin',
        message: 'Sign in (free) to create a ranked match.',
      },
      401,
    );
  }

  // Honor gates: low-honor users are locked out of competitive modes.
  // Thresholds are admin-tunable via game_rules.honor.gates.
  if (c.var.user) {
    const { getCategory } = await import('../game-rules/loader.js');
    const honorRules = await getCategory('honor');
    const [userRow] = await d
      .select({ honor: users.honor })
      .from(users)
      .where(eq(users.id, c.var.user.id))
      .limit(1);
    const currentHonor = userRow?.honor ?? honorRules.start;

    let gateThreshold: number | null = null;
    let gateLabel = '';
    if (currentHonor < honorRules.gates.readOnlyBelow) {
      gateThreshold = honorRules.gates.readOnlyBelow;
      gateLabel = 'creating any match';
    } else if (body.mode === 'tournament' && currentHonor < honorRules.gates.tournament) {
      gateThreshold = honorRules.gates.tournament;
      gateLabel = 'tournament';
    } else if (body.mode === 'ranked' && currentHonor < honorRules.gates.ranked) {
      gateThreshold = honorRules.gates.ranked;
      gateLabel = 'ranked';
    } else if (body.mode === 'private' && currentHonor < honorRules.gates.privateHosting) {
      gateThreshold = honorRules.gates.privateHosting;
      gateLabel = 'private room hosting';
    }
    if (gateThreshold !== null) {
      return c.json(
        {
          error: 'low_honor',
          message: `Honor too low for ${gateLabel}. You have ${currentHonor}, need ${gateThreshold}. Play some clean matches to recover.`,
        },
        403,
      );
    }
  }

  // ─── Matchmaking (Quick Play / Ranked) ──────────────────────────────────
  // If genre was not pinned by the caller (default for Quick Play), look
  // at open lobbies across ALL system genres - any free seat is a match.
  // Only when nothing's open do we pick a random system genre and create
  // a fresh lobby. Genre-pinned (ranked with explicit genreSlug, private,
  // practice) behaves like before.
  if (body.mode === 'quickplay' || body.mode === 'ranked' || body.mode === 'flip') {
    const openLobbies = await d.execute<{
      id: string;
      room_code: string;
      mode: string;
      status: string;
      team_size: number;
      team_count: number;
      submit_seconds: number | null;
      created_at: string;
      seated: number;
      genre_slug: string;
      genre_name: string;
    }>(
      // Matchmaking window: tight (90 seconds) and prefer emptier lobbies.
      // Rooms older than 90s with stale seated players (from crashed tabs,
      // previous test runs, etc.) get ignored - two fresh Quick Play clicks
      // within the window pair up, instead of one of them filling a
      // half-dead lobby and the other ending up alone.
      body.genreSlug
        ? sql`SELECT m.id, m.room_code, m.mode, m.status,
                     m.team_size, m.team_count, m.submit_seconds, m.created_at,
                     (SELECT COUNT(*)::int FROM match_players
                       WHERE match_id = m.id AND is_spectator = false) AS seated,
                     g.slug AS genre_slug, g.name AS genre_name
                FROM matches m
                JOIN genres g ON g.id = m.primary_genre_id
               WHERE m.mode = ${body.mode}
                 AND m.status = 'lobby'
                 AND g.slug = ${body.genreSlug}
                 AND m.room_code IS NOT NULL
                 AND m.created_at > now() - interval '90 seconds'
               ORDER BY
                 (SELECT COUNT(*)::int FROM match_players
                    WHERE match_id = m.id AND is_spectator = false) ASC,
                 m.created_at DESC
               LIMIT 5`
        : sql`SELECT m.id, m.room_code, m.mode, m.status,
                     m.team_size, m.team_count, m.submit_seconds, m.created_at,
                     (SELECT COUNT(*)::int FROM match_players
                       WHERE match_id = m.id AND is_spectator = false) AS seated,
                     g.slug AS genre_slug, g.name AS genre_name
                FROM matches m
                JOIN genres g ON g.id = m.primary_genre_id
               WHERE m.mode = ${body.mode}
                 AND m.status = 'lobby'
                 AND g.kind = 'system'
                 AND m.room_code IS NOT NULL
                 AND m.created_at > now() - interval '90 seconds'
               ORDER BY
                 (SELECT COUNT(*)::int FROM match_players
                    WHERE match_id = m.id AND is_spectator = false) ASC,
                 m.created_at DESC
               LIMIT 10`,
    );

    // Prefer lobbies that are still waiting for the 4-player minimum (1-3 seated)
    // over those that are already at or above the minimum but still not full.
    // This batches new players into the same lobby rather than fragmenting.
    //
    // Anti-smurf cluster guard: fires for all competitive PvP modes that
    // produce a leaderboard (ranked, quickplay, flip, tournament). Practice
    // and daily are excluded - practice is solo, daily is open audience.
    //
    // Behaviour by mode:
    //   ranked    - hard block: collision lobbies are filtered out entirely
    //   quickplay / flip / tournament - soft signal: lobby is skipped but
    //     the collision is logged so ops can review patterns without
    //     disrupting casual matchmaking.
    const CLUSTER_HARD_MODES = new Set(['ranked']);
    const CLUSTER_SOFT_MODES = new Set(['quickplay', 'flip', 'tournament']);
    type LobbyRow = (typeof openLobbies)[number];
    let candidates: LobbyRow[] = Array.from(openLobbies);
    if (c.var.user && (CLUSTER_HARD_MODES.has(body.mode) || CLUSTER_SOFT_MODES.has(body.mode))) {
      const { isClusterMatch } = await import('../matchmaking/cluster-guard.js');
      const filtered: LobbyRow[] = [];
      // Serial loop is fine: openLobbies is small (a few rows in practice)
      // and each isClusterMatch is one indexed query.
      for (const lobby of candidates) {
        const collision = await isClusterMatch(lobby.id, c.var.user.id);
        if (!collision) {
          filtered.push(lobby);
        } else if (CLUSTER_SOFT_MODES.has(body.mode)) {
          // Soft signal: log and allow the lobby to be skipped. The caller
          // may still get seated via a newly-created lobby below, but won't
          // share a room with the colliding player from this lobby.
          console.warn('[cluster-guard] soft collision', {
            mode: body.mode,
            matchId: lobby.id,
            userId: c.var.user.id,
          });
        }
        // Hard modes: collision lobby silently dropped (no filtered.push).
      }
      candidates = filtered;
    }

    const waitingForMin = candidates.find((m) => Number(m.seated) > 0 && Number(m.seated) < 4);
    const available =
      waitingForMin ??
      candidates.find(
        (m) =>
          Number(m.seated) >= 4 && Number(m.seated) < Number(m.team_size) * Number(m.team_count),
      ) ??
      candidates.find((m) => Number(m.seated) < Number(m.team_size) * Number(m.team_count));
    if (available) {
      const submitSeconds = available.submit_seconds ?? SUBMIT_SECONDS_DEFAULT[body.mode] ?? 300;
      return c.json(
        {
          id: available.id,
          mode: body.mode,
          roomCode: available.room_code,
          teamSize: available.team_size,
          teamCount: available.team_count,
          submitSeconds,
          genre: { slug: available.genre_slug, name: available.genre_name },
          status: available.status,
          createdAt: new Date(available.created_at).toISOString(),
          samplePack: null, // already generated at original creation
          flipSource: null, // client can re-fetch via GET /matches/{code}
        },
        201,
      );
    }
  }

  // No match joined → create a new one. Resolve the genre:
  //   - if caller passed genreSlug, use it (still validated below).
  //   - else pick a random system genre.
  let resolvedSlug = body.genreSlug;
  if (!resolvedSlug) {
    // For modes that need a generated sample pack, restrict the random
    // picker to genres that actually have at least one pool pack seeded.
    // Without this filter we'd sometimes pick a genre with no packs and
    // generateMatchPack would throw, leaving the match with samplePack=null.
    // Sample Flip uses sample_mode='none', so it's allowed any active system genre.
    const needsPack = DEFAULT_SAMPLE_MODE[body.mode] === 'generated';
    const systemGenres = needsPack
      ? await d.execute<{ slug: string }>(
          sql`SELECT g.slug FROM genres g
               WHERE g.kind = 'system' AND g.status = 'active'
                 AND EXISTS (
                   SELECT 1 FROM sample_packs sp
                    WHERE sp.genre_id = g.id AND sp.kind = 'pool'
                 )`,
        )
      : await d.execute<{ slug: string }>(
          sql`SELECT slug FROM genres WHERE kind = 'system' AND status = 'active'`,
        );
    if (systemGenres.length === 0) {
      return c.json(
        {
          error: 'no_system_genres_with_packs',
          message: needsPack
            ? 'No system genre has a pool pack seeded yet. Ask an admin to generate one.'
            : 'No system genres configured.',
        },
        503,
      );
    }
    resolvedSlug = (
      systemGenres[Math.floor(Math.random() * systemGenres.length)] as { slug: string }
    ).slug;
  }

  const [genre] = await d.select().from(genres).where(eq(genres.slug, resolvedSlug)).limit(1);
  if (!genre) return c.json({ error: 'genre not found' }, 404);

  if (
    (body.mode === 'quickplay' || body.mode === 'ranked' || body.mode === 'flip') &&
    genre.kind !== 'system'
  ) {
    return c.json({ error: `${body.mode} requires a system genre` }, 400);
  }

  // For Sample Flip: resolve the flip source. If the caller passed one,
  // honour it; otherwise pick a random active source (filtered by genre
  // when we have one, else global). If nothing's available, reject - a
  // flip match without a source to flip has no prompt.
  let flipSource: typeof flipSources.$inferSelect | null = null;
  if (body.mode === 'flip') {
    if (body.flipSourceId) {
      const [picked] = await d
        .select()
        .from(flipSources)
        .where(eq(flipSources.id, body.flipSourceId))
        .limit(1);
      if (!picked || !picked.active) {
        return c.json({ error: 'flip source not available' }, 404);
      }
      flipSource = picked;
    } else {
      // Prefer sources tagged with the chosen genre; fall back to any
      // active source if none match. ORDER BY random() is cheap at this
      // table's size and keeps rotation feeling fresh.
      const pickedByGenre = await d.execute<{
        id: string;
        label: string;
        url: string;
        duration_sec: number | null;
      }>(
        sql`SELECT id, label, url, duration_sec
              FROM flip_sources
             WHERE active = true
               AND genre_id = ${genre.id}
             ORDER BY random()
             LIMIT 1`,
      );
      const pickedAny = pickedByGenre.length
        ? pickedByGenre
        : await d.execute<{ id: string; label: string; url: string; duration_sec: number | null }>(
            sql`SELECT id, label, url, duration_sec
                  FROM flip_sources
                 WHERE active = true
                 ORDER BY random()
                 LIMIT 1`,
          );
      const pickRow = pickedAny[0];
      if (!pickRow) {
        return c.json({ error: 'no flip sources available' }, 503);
      }
      // Load the full row so downstream inserts and responses share one shape.
      const [full] = await d
        .select()
        .from(flipSources)
        .where(eq(flipSources.id, pickRow.id))
        .limit(1);
      if (!full) return c.json({ error: 'no flip sources available' }, 503);
      flipSource = full;
    }
  }

  const submitSeconds = body.submitSeconds ?? SUBMIT_SECONDS_DEFAULT[body.mode];

  // Determine sample mode: follow the per-mode default.
  const sampleMode = DEFAULT_SAMPLE_MODE[body.mode];

  // Find a free room code. Unique constraint will reject collisions; retry a few times.
  let created: typeof matches.$inferSelect | undefined;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    const code = randomRoomCode();
    // Quick Play and Ranked use FFA-8 (teamSize=1, teamCount=8) regardless
    // of what the caller sends; the body's teamSize/teamCount defaults are
    // preserved for private/tournament/practice/flip.
    const effectiveTeamSize =
      body.mode === 'quickplay' || body.mode === 'ranked' ? 1 : body.teamSize;
    const effectiveTeamCount =
      body.mode === 'quickplay' || body.mode === 'ranked' ? 8 : body.teamCount;

    // Visibility in /lobbies: private rooms default invite-only and only
    // appear if the host explicitly ticks "list publicly". Every other mode
    // is auto-discoverable, since matchmaking already shares those lobbies.
    const isPublic = body.mode === 'private' ? body.isPublic === true : true;

    try {
      const [row] = await d
        .insert(matches)
        .values({
          mode: body.mode,
          status: 'lobby',
          roomCode: code,
          teamSize: effectiveTeamSize,
          teamCount: effectiveTeamCount,
          primaryGenreId: genre.id,
          submitSeconds,
          sampleMode,
          flipSourceId: flipSource?.id ?? null,
          isPublic,
          // Track who created the room. Today only used for "host can start a
          // private room when everyone's ready" - other modes ignore it.
          hostId: c.var.user?.id ?? null,
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

  // Narrow into a stable local so TypeScript/closures don't lose the guard.
  const match = created;

  // Seat the teams in advance so WS joiners have slots to map to.
  await d.insert(matchTeams).values(
    Array.from({ length: match.teamCount }, (_, seat) => ({
      matchId: match.id,
      seat,
      name: String.fromCharCode(65 + seat),
    })),
  );

  // Generate a sample pack when the mode requires one.
  let generatedPack: {
    id: string;
    samples: { stemType: string; name: string; url: string }[];
  } | null = null;
  if (sampleMode === 'generated') {
    try {
      // Ranked must not let the caller pick a pack - it would let people
      // farm their best stems. Quickplay is also server-picked. Pack
      // picking is private-room only (and uploaded packs are owner-only).
      const allowClientPick = body.mode === 'private';
      // If the caller passed an explicit samplePackId, honour it (after
      // ownership + genre-match checks); otherwise pick a random pool pack.
      let pack: typeof samplePacks.$inferSelect;
      if (body.samplePackId && allowClientPick) {
        const [picked] = await d
          .select()
          .from(samplePacks)
          .where(eq(samplePacks.id, body.samplePackId))
          .limit(1);
        if (!picked) {
          await d.delete(matches).where(eq(matches.id, match.id));
          return c.json({ error: 'pack_not_found', message: 'samplePackId does not exist.' }, 404);
        }
        if (picked.genreId !== genre.id) {
          await d.delete(matches).where(eq(matches.id, match.id));
          return c.json(
            {
              error: 'pack_genre_mismatch',
              message: `Pack belongs to a different genre than ${genre.slug}.`,
            },
            400,
          );
        }
        const callerId = c.var.user?.id ?? null;
        const isPool = picked.kind === 'pool';
        const isMine = picked.kind === 'uploaded' && picked.createdBy === callerId;
        if (!isPool && !isMine) {
          await d.delete(matches).where(eq(matches.id, match.id));
          return c.json(
            {
              error: 'pack_not_usable',
              message:
                'You can only pick pool packs or your own uploaded packs. Ask an admin to promote it to the pool to share.',
            },
            403,
          );
        }
        pack = picked;
      } else {
        pack = await generateMatchPack(match.id, resolvedSlug, {
          userId: c.var.user?.id ?? null,
        });
      }
      // Link the pack back to the match.
      await d.update(matches).set({ samplePackId: pack.id }).where(eq(matches.id, match.id));
      // Append-only ledger row. One row per (match, pack); retained for
      // analytics.
      await d
        .insert(packPlays)
        .values({ packId: pack.id, matchId: match.id })
        .catch((err: Error) => console.warn('[pack-plays] insert failed:', err.message));
      const signedSamples = await Promise.all(
        pack.samples.map(async (s) => ({ ...s, url: await signUrl(s.url, 3600) })),
      );
      generatedPack = { id: pack.id, samples: signedSamples };
    } catch (err) {
      // No pool packs for this genre means the match is unplayable - the
      // submit screen would render no kit and producers would have nothing
      // to flip. Roll back the just-created match row and return 503 so the
      // client can show a real error instead of dropping the user into an
      // empty room.
      console.warn('[matches] sample pack generation failed:', (err as Error).message);
      await d.delete(matches).where(eq(matches.id, match.id));
      return c.json(
        {
          error: 'pack_generation_failed',
          message:
            'Could not assemble a sample pack for this genre. An admin needs to generate a pool pack first.',
          genreSlug: resolvedSlug,
        },
        503,
      );
    }
  }

  return c.json(
    {
      id: match.id,
      mode: match.mode,
      roomCode: match.roomCode ?? '',
      teamSize: match.teamSize,
      teamCount: match.teamCount,
      submitSeconds,
      genre: { slug: genre.slug, name: genre.name },
      status: match.status,
      createdAt: match.createdAt.toISOString(),
      samplePack: generatedPack,
      flipSource: flipSource
        ? {
            id: flipSource.id,
            label: flipSource.label,
            url: await signUrl(flipSource.url, 3600),
            durationSec: flipSource.durationSec ?? null,
          }
        : null,
      lobbyStartsAt: null,
      voteOutcome: null,
      voteStats: { seated: 0, voted: 0, fullVoted: 0 },
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
    // ?user=<handle> lets guest callers get their own mySubmission
    // populated without a session cookie. Authenticated callers can
    // omit it - the session wins.
    query: z.object({ user: z.string().optional() }),
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
  const { user: handleParam } = c.req.valid('query');
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
      samplePackId: matches.samplePackId,
      sampleMode: matches.sampleMode,
      flipSourceId: matches.flipSourceId,
      lobbyStartsAt: matches.lobbyStartsAt,
      voteOutcomeCol: matches.voteOutcome,
    })
    .from(matches)
    .innerJoin(genres, eq(genres.id, matches.primaryGenreId))
    .where(eq(matches.roomCode, code))
    .limit(1);

  if (!row || !row.roomCode) return c.json({ error: 'not found' }, 404);

  // Active battle-phase (if any) - drives the client's countdown on refresh.
  const [phase] = await d.execute<{
    current_phase: string;
    transitions_at: string;
  }>(
    sql`SELECT current_phase, transitions_at
          FROM battle_phases
         WHERE match_id = ${row.id}`,
  );

  // Vote-completeness counts for the Results "partial tally" pill. Two
  // numbers we surface:
  //   - voted: any seated player who cast at least one vote.
  //   - fullVoted: voters who scored every non-self submission they had
  //     access to (per-voter votable count, since not everyone submits).
  // Self-votes are dropped server-side so the per-voter threshold is
  // (total submissions) - (1 if the voter submitted, else 0).
  const [voteStatsRow] = (await d.execute<{ seated: number; voted: number; full: number }>(sql`
    WITH per_voter AS (
      SELECT mp.user_id AS voter_id,
             (SELECT COUNT(*)::int FROM submissions s
               WHERE s.match_id = ${row.id} AND s.user_id != mp.user_id) AS votable,
             COALESCE((SELECT COUNT(*)::int FROM votes v
                        WHERE v.match_id = ${row.id} AND v.voter_id = mp.user_id), 0) AS votes_cast
        FROM match_players mp
       WHERE mp.match_id = ${row.id} AND mp.is_spectator = false
    )
    SELECT COUNT(*)::int AS seated,
           COUNT(*) FILTER (WHERE votes_cast >= 1)::int AS voted,
           COUNT(*) FILTER (WHERE votable = 0 OR votes_cast >= votable)::int AS full
      FROM per_voter
  `)) as unknown as [{ seated: number; voted: number; full: number }];

  // Load the associated sample pack if present.
  let packPayload: {
    id: string;
    samples: { stemType: string; name: string; url: string }[];
  } | null = null;
  if (row.samplePackId) {
    const [pack] = await d
      .select()
      .from(samplePacks)
      .where(eq(samplePacks.id, row.samplePackId))
      .limit(1);
    if (pack) {
      const signedSamples = await Promise.all(
        pack.samples.map(async (s) => ({ ...s, url: await signUrl(s.url, 3600) })),
      );
      packPayload = { id: pack.id, samples: signedSamples };
    }
  }

  let flipSourcePayload: {
    id: string;
    label: string;
    url: string;
    durationSec: number | null;
  } | null = null;
  if (row.flipSourceId) {
    const [fs] = await d
      .select()
      .from(flipSources)
      .where(eq(flipSources.id, row.flipSourceId))
      .limit(1);
    if (fs) {
      flipSourcePayload = {
        id: fs.id,
        label: fs.label,
        url: await signUrl(fs.url, 3600),
        durationSec: fs.durationSec ?? null,
      };
    }
  }

  // Identify the caller so we can surface their existing submission (if any).
  // Authenticated session wins; ?user=<handle> lets guests opt in too.
  let callerUserId: string | null = c.var.user?.id ?? null;
  if (!callerUserId && handleParam) {
    const [u] = await d
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, handleParam))
      .limit(1);
    callerUserId = u?.id ?? null;
  }

  let mySubmission: {
    id: string;
    audioUrl: string;
    title: string | null;
    durationSec: number | null;
  } | null = null;
  if (callerUserId) {
    const [sub] = await d
      .select({
        id: submissions.id,
        audioUrl: submissions.audioUrl,
        title: submissions.title,
        durationSec: submissions.durationSec,
      })
      .from(submissions)
      .where(and(eq(submissions.matchId, row.id), eq(submissions.userId, callerUserId)))
      .limit(1);
    if (sub) {
      mySubmission = {
        id: sub.id,
        audioUrl: await signUrl(sub.audioUrl, 3600),
        title: sub.title ?? null,
        durationSec: sub.durationSec ?? null,
      };
    }
  }

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
    samplePack: packPayload,
    flipSource: flipSourcePayload,
    currentPhase: phase?.current_phase ?? null,
    transitionsAt: phase ? new Date(phase.transitions_at).getTime() : null,
    lobbyStartsAt: row.lobbyStartsAt ? row.lobbyStartsAt.toISOString() : null,
    voteOutcome: row.voteOutcomeCol ?? null,
    voteStats: {
      seated: voteStatsRow?.seated ?? 0,
      voted: voteStatsRow?.voted ?? 0,
      fullVoted: voteStatsRow?.full ?? 0,
    },
    mySubmission,
  });
});
