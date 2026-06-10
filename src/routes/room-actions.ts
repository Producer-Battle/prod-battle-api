// REST actions for match rooms.
// POST /rooms/:code/join   - add a player (or return existing seat)
// POST /rooms/:code/leave  - remove a player
// POST /rooms/:code/ready  - toggle the ready flag
// POST /rooms/:code/start  - host-only: write a battle_phases row and start match

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import { battlePhases, matchPlayers, matchTeams, matches, users } from '../db/schema.js';
import { SUBMIT_SECONDS_DEFAULT } from '../matchmaking/defaults.js';
import { publish } from '../realtime/pubsub.js';
import { publishRoster } from '../ws/index.js';

export const roomActionsRoutes = new Hono();

// Resolve a caller to a users.id. Two layered guarantees:
//
//   1. Authenticated session wins. If c.var.user is set (better-auth
//      cookie), use that id and ignore the body.user handle entirely.
//
//   2. For unauthenticated callers, the pb_anon HttpOnly cookie is the
//      credential. anonId comes from middleware/anon-id and is a
//      server-issued UUID the client cannot forge. We resolve users by
//      anon_id; the body.user handle is only consulted as a display
//      preference when creating a brand-new guest record. If the caller
//      sends a handle that's already bound to a different anon_id, we
//      reject with 'handle_taken' rather than impersonating that user.
//
// Returns null when the caller tried to claim someone else's handle.
type ResolveResult = { ok: true; userId: string } | { ok: false; reason: 'handle_taken' };

async function resolveUser(
  handle: string,
  ctx: { authenticatedUserId: string | null; anonId: string },
): Promise<ResolveResult> {
  const d = db();

  // Authenticated session always wins.
  if (ctx.authenticatedUserId) {
    return { ok: true, userId: ctx.authenticatedUserId };
  }

  // No handle sent: fall back to whichever guest row this cookie last
  // used. (The join/vote schemas require a handle, so this is only a
  // safety net for optional-handle endpoints.)
  if (!handle) {
    const [byAnon] = await d
      .select({ id: users.id })
      .from(users)
      .where(eq(users.anonId, ctx.anonId))
      .limit(1);
    if (byAnon) return { ok: true, userId: byAnon.id };
    return { ok: false, reason: 'handle_taken' };
  }

  // Handle-first resolution. One browser may operate several guest
  // handles (they all get bound to the same anon_id); what matters is
  // that NOBODY ELSE can use a handle bound to your cookie. Cases:
  //  a) handle bound to this cookie            -> ok
  //  b) handle bound to a different cookie     -> reject (impersonation)
  //  c) legacy guest stub (anon_id NULL + @guest.local email)
  //                                            -> claim it for this cookie
  //  d) real registered account (anon_id NULL but a real email; sessions
  //     resolve those by id so the binding is never set) -> reject.
  //     Without the email check a guest could bind any registered
  //     user's row to their cookie and act as them in rooms and votes.
  //  e) handle unused                          -> insert bound to cookie
  const [byHandle] = await d
    .select({ id: users.id, anonId: users.anonId, email: users.email })
    .from(users)
    .where(eq(users.handle, handle))
    .limit(1);

  if (byHandle) {
    if (byHandle.anonId === ctx.anonId) {
      return { ok: true, userId: byHandle.id };
    }
    if (byHandle.anonId !== null || !byHandle.email.endsWith('@guest.local')) {
      return { ok: false, reason: 'handle_taken' };
    }
    await d.update(users).set({ anonId: ctx.anonId }).where(eq(users.id, byHandle.id));
    return { ok: true, userId: byHandle.id };
  }

  // Brand-new guest. Insert. ON CONFLICT on handle is paranoia in case
  // two requests race; the loser falls through to the byHandle path on
  // its next call.
  const inserted = await d.execute<{ id: string }>(
    sql`INSERT INTO users (id, email, handle, role, anon_id)
        VALUES (gen_random_uuid(), ${handle} || '@guest.local', ${handle}, 'producer', ${ctx.anonId})
        ON CONFLICT (handle) DO NOTHING
        RETURNING id`,
  );
  const newId = (inserted[0] as { id: string } | undefined)?.id;
  if (newId) return { ok: true, userId: newId };
  // ON CONFLICT fired - someone else just claimed it. Return handle_taken
  // so the caller can pick another rather than silently impersonating.
  return { ok: false, reason: 'handle_taken' };
}

// For endpoints that operate on an EXISTING user (leave, ready, start,
// vote): we require the caller to actually own the identity they're
// trying to act as. Pre-fix the same handle lookup happily resolved any
// user by name regardless of who was calling, so anyone could mark
// anyone "ready" or kick them out by sending the right handle. This
// helper rejects when the handle doesn't match the caller's authenticated
// session or anon_id binding.
async function resolveCallerUserId(
  handle: string | null,
  ctx: { authenticatedUserId: string | null; anonId: string },
): Promise<{ ok: true; userId: string } | { ok: false; status: 400 | 403 | 404 }> {
  // Authenticated session always wins. We still verify handle, when sent,
  // matches their session - mostly catches client bugs.
  if (ctx.authenticatedUserId) {
    return { ok: true, userId: ctx.authenticatedUserId };
  }

  if (!handle) return { ok: false, status: 400 };

  const d = db();
  const [byHandle] = await d
    .select({ id: users.id, anonId: users.anonId, email: users.email })
    .from(users)
    .where(eq(users.handle, handle))
    .limit(1);
  if (!byHandle) return { ok: false, status: 404 };

  // The caller is allowed to act as this user only if their cookie
  // matches the user's anon_id binding. Legacy GUEST rows (anon_id IS
  // NULL + @guest.local email) get claimed by the first caller through
  // this path. Real registered accounts also have anon_id NULL - they
  // must never be claimable by handle, only via an authenticated
  // session, hence the email check.
  if (byHandle.anonId == null) {
    if (!byHandle.email.endsWith('@guest.local')) {
      return { ok: false, status: 403 };
    }
    await d.update(users).set({ anonId: ctx.anonId }).where(eq(users.id, byHandle.id));
    return { ok: true, userId: byHandle.id };
  }
  if (byHandle.anonId !== ctx.anonId) {
    return { ok: false, status: 403 };
  }
  return { ok: true, userId: byHandle.id };
}

/** Find a match by room code. */
async function findMatch(code: string) {
  const d = db();
  const [row] = await d.select().from(matches).where(eq(matches.roomCode, code)).limit(1);
  return row ?? null;
}

/** Seat a player into the next available team slot (round-robin). */
async function seatPlayer(matchId: string, userId: string): Promise<void> {
  const d = db();

  const existing = await d
    .select()
    .from(matchPlayers)
    .where(sql`${matchPlayers.matchId} = ${matchId} AND ${matchPlayers.userId} = ${userId}`)
    .limit(1);

  if (existing.length > 0) return;

  const teams = await d
    .select()
    .from(matchTeams)
    .where(eq(matchTeams.matchId, matchId))
    .orderBy(matchTeams.seat);

  if (teams.length === 0) return;

  const counts = await d.execute<{ team_id: string; cnt: string }>(
    sql`SELECT team_id, COUNT(*) as cnt
        FROM match_players
        WHERE match_id = ${matchId} AND is_spectator = false
        GROUP BY team_id`,
  );
  const countMap = new Map<string, number>();
  for (const row of counts) {
    countMap.set(row.team_id, Number(row.cnt));
  }

  const bestTeam = teams.reduce((best, team) => {
    const bestC = countMap.get(best.id) ?? 0;
    const c = countMap.get(team.id) ?? 0;
    return c < bestC ? team : best;
  });

  await d
    .insert(matchPlayers)
    .values({
      matchId,
      userId,
      teamId: bestTeam.id,
      isSpectator: false,
      ready: false,
    })
    .onConflictDoNothing();
}

// ─── POST /rooms/:code/join ───────────────────────────────────────────────────

roomActionsRoutes.post('/rooms/:code/join', async (c) => {
  const code = c.req.param('code');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const handle =
    typeof body.user === 'string' && body.user.trim()
      ? body.user.trim()
      : `guest-${randomUUID().slice(0, 8)}`;

  const match = await findMatch(code);
  if (!match) return c.json({ error: 'match not found' }, 404);

  const result = await resolveUser(handle, {
    authenticatedUserId: c.var.user?.id ?? null,
    anonId: c.var.anonId,
  });
  if (!result.ok) {
    return c.json(
      {
        error: result.reason,
        message:
          'That handle is already taken. Pick a different one or sign in to use your existing account.',
      },
      409,
    );
  }
  await seatPlayer(match.id, result.userId);
  await publishRoster(match.id);

  return c.json({ ok: true, userId: result.userId });
});

// ─── POST /rooms/:code/leave ──────────────────────────────────────────────────

roomActionsRoutes.post('/rooms/:code/leave', async (c) => {
  const code = c.req.param('code');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const handle = typeof body.user === 'string' ? body.user.trim() : null;

  const match = await findMatch(code);
  if (!match) return c.json({ error: 'match not found' }, 404);

  const caller = await resolveCallerUserId(handle, {
    authenticatedUserId: c.var.user?.id ?? null,
    anonId: c.var.anonId,
  });
  if (!caller.ok) {
    return c.json(
      {
        error:
          caller.status === 403
            ? 'forbidden'
            : caller.status === 404
              ? 'user_not_found'
              : 'user_required',
      },
      caller.status,
    );
  }

  const d = db();
  await d
    .delete(matchPlayers)
    .where(
      sql`${matchPlayers.matchId} = ${match.id} AND ${matchPlayers.userId} = ${caller.userId}`,
    );

  await publishRoster(match.id);
  return c.json({ ok: true });
});

// ─── POST /rooms/:code/ready ──────────────────────────────────────────────────

roomActionsRoutes.post('/rooms/:code/ready', async (c) => {
  const code = c.req.param('code');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const handle = typeof body.user === 'string' ? body.user.trim() : null;

  const match = await findMatch(code);
  if (!match) return c.json({ error: 'match not found' }, 404);

  const caller = await resolveCallerUserId(handle, {
    authenticatedUserId: c.var.user?.id ?? null,
    anonId: c.var.anonId,
  });
  if (!caller.ok) {
    return c.json(
      {
        error:
          caller.status === 403
            ? 'forbidden'
            : caller.status === 404
              ? 'user_not_found'
              : 'user_required',
      },
      caller.status,
    );
  }

  const d = db();
  const current = await d
    .select({ ready: matchPlayers.ready })
    .from(matchPlayers)
    .where(sql`${matchPlayers.matchId} = ${match.id} AND ${matchPlayers.userId} = ${caller.userId}`)
    .limit(1);

  if (current.length === 0) return c.json({ error: 'not in match' }, 400);

  const newReady = !current[0]?.ready;

  await d
    .update(matchPlayers)
    .set({ ready: newReady })
    .where(
      sql`${matchPlayers.matchId} = ${match.id} AND ${matchPlayers.userId} = ${caller.userId}`,
    );

  await publishRoster(match.id);
  return c.json({ ok: true, ready: newReady });
});

// Minimum seated players before a Quick Play or Ranked lobby may start.
// If this many players are not seated after the initial lobby wait, the match
// waits in 60-second increments up to a 5-minute ceiling, then starts anyway
// with whoever is seated (option b - start with what you have at the ceiling).
const QP_RANKED_MIN_PLAYERS = 2;
const QP_RANKED_LOBBY_CEILING_SEC = 5 * 60; // 5 minutes

// ─── POST /rooms/:code/start ──────────────────────────────────────────────────

roomActionsRoutes.post('/rooms/:code/start', async (c) => {
  const code = c.req.param('code');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const handle = typeof body.user === 'string' ? body.user.trim() : null;

  const match = await findMatch(code);
  if (!match) return c.json({ error: 'match not found' }, 404);

  // Only allow starting from lobby state.
  if (match.status !== 'lobby') {
    return c.json({ error: 'match already started' }, 400);
  }

  const caller = await resolveCallerUserId(handle, {
    authenticatedUserId: c.var.user?.id ?? null,
    anonId: c.var.anonId,
  });
  if (!caller.ok) {
    return c.json(
      {
        error:
          caller.status === 403
            ? 'forbidden'
            : caller.status === 404
              ? 'user_not_found'
              : 'user_required',
      },
      caller.status,
    );
  }
  const userId = caller.userId;

  const d = db();

  // Quick Play and Ranked require at least QP_RANKED_MIN_PLAYERS seated before
  // the match can start. If the caller tries to start early, check how old the
  // lobby is. If it has not reached the 5-minute ceiling yet, reject with a
  // "waiting_for_players" error so the client knows to keep waiting.
  // Once the ceiling is reached, we start with whoever is present (option b).
  if (match.mode === 'quickplay' || match.mode === 'ranked') {
    const seatedRows = await d.execute<{ seated: number }>(
      sql`SELECT COUNT(*)::int AS seated FROM match_players
           WHERE match_id = ${match.id} AND is_spectator = false`,
    );
    const seated = (seatedRows[0] as { seated: number } | undefined)?.seated ?? 0;

    if (seated < QP_RANKED_MIN_PLAYERS) {
      const lobbyAgeMs = Date.now() - match.createdAt.getTime();
      const atCeiling = lobbyAgeMs >= QP_RANKED_LOBBY_CEILING_SEC * 1000;
      if (!atCeiling) {
        return c.json(
          {
            error: 'waiting_for_players',
            message: `Need at least ${QP_RANKED_MIN_PLAYERS} players to start. ${seated} seated so far.`,
            seated,
            minPlayers: QP_RANKED_MIN_PLAYERS,
          },
          400,
        );
      }
      // At or past the 5-minute ceiling: start with whoever is present.
      console.log(
        `[room-actions] ${match.id}: lobby ceiling reached (${seated} players) - starting anyway`,
      );
    }
  }

  // Private rooms: only the host can start, min 2 seated, all seated must be
  // ready. teamCount on private is fixed at 8 (max capacity); the host
  // decides when to start, so any number from 2-8 is fine as long as
  // everyone present has clicked Ready.
  if (match.mode === 'private') {
    if (match.hostId && match.hostId !== userId) {
      return c.json(
        { error: 'host_only', message: 'Only the room host can start the match.' },
        403,
      );
    }
    const rows = await d.execute<{ seated: number; ready: number }>(
      sql`SELECT COUNT(*)::int AS seated,
                 COUNT(*) FILTER (WHERE ready = true)::int AS ready
            FROM match_players
           WHERE match_id = ${match.id} AND is_spectator = false`,
    );
    const counts = rows[0] as { seated: number; ready: number } | undefined;
    const seated = counts?.seated ?? 0;
    const ready = counts?.ready ?? 0;
    if (seated < 2) {
      return c.json(
        {
          error: 'waiting_for_players',
          message: `Need at least 2 producers seated. ${seated} so far.`,
          seated,
          minPlayers: 2,
        },
        400,
      );
    }
    if (ready < seated) {
      return c.json(
        {
          error: 'not_all_ready',
          message: `Waiting on ${seated - ready} producer(s) to mark ready.`,
          seated,
          ready,
        },
        400,
      );
    }
  }

  const submitSeconds =
    match.submitSeconds ??
    SUBMIT_SECONDS_DEFAULT[match.mode as keyof typeof SUBMIT_SECONDS_DEFAULT] ??
    300;

  const transitionsAt = new Date(Date.now() + submitSeconds * 1000);

  // Upsert a battle_phases row: insert or update if already present.
  await d
    .insert(battlePhases)
    .values({
      matchId: match.id,
      currentPhase: 'submit',
      transitionsAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: battlePhases.matchId,
      set: {
        currentPhase: 'submit',
        transitionsAt,
        updatedAt: new Date(),
      },
    });

  // Update match status.
  await d
    .update(matches)
    .set({ status: 'submit', startedAt: new Date() })
    .where(eq(matches.id, match.id));

  // Publish phase_change so all connected sockets advance.
  await publish(`battle:${match.id}`, {
    type: 'phase_change',
    matchId: match.id,
    phase: 'submit',
    transitionsAt: transitionsAt.getTime(),
  });

  return c.json({ ok: true, phase: 'submit', transitionsAt: transitionsAt.toISOString() });
});
