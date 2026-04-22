// REST actions for match rooms.
// POST /rooms/:code/join   — add a player (or return existing seat)
// POST /rooms/:code/leave  — remove a player
// POST /rooms/:code/ready  — toggle the ready flag
// POST /rooms/:code/start  — host-only: write a battle_phases row and start match

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import { battlePhases, matchPlayers, matchTeams, matches } from '../db/schema.js';
import { SUBMIT_SECONDS_DEFAULT } from '../matchmaking/defaults.js';
import { publish } from '../realtime/pubsub.js';
import { publishRoster } from '../ws/index.js';

export const roomActionsRoutes = new Hono();

/** Resolve or create a guest user by handle. Returns the user's id. */
async function resolveUser(handle: string): Promise<string> {
  const d = db();
  const rows = await d.execute<{ id: string }>(
    sql`INSERT INTO users (id, email, handle, role)
        VALUES (gen_random_uuid(), ${handle} || '@guest.local', ${handle}, 'producer')
        ON CONFLICT (handle) DO UPDATE SET handle = EXCLUDED.handle
        RETURNING id`,
  );
  const row = rows[0] as { id: string } | undefined;
  return row?.id ?? randomUUID();
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

  const userId = await resolveUser(handle);
  await seatPlayer(match.id, userId);
  await publishRoster(match.id);

  return c.json({ ok: true, userId });
});

// ─── POST /rooms/:code/leave ──────────────────────────────────────────────────

roomActionsRoutes.post('/rooms/:code/leave', async (c) => {
  const code = c.req.param('code');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const handle = typeof body.user === 'string' ? body.user.trim() : null;

  if (!handle) return c.json({ error: 'user required' }, 400);

  const match = await findMatch(code);
  if (!match) return c.json({ error: 'match not found' }, 404);

  const d = db();
  const userRows = await d.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE handle = ${handle} LIMIT 1`,
  );
  const userId = (userRows[0] as { id: string } | undefined)?.id;
  if (!userId) return c.json({ error: 'user not found' }, 404);

  await d
    .delete(matchPlayers)
    .where(sql`${matchPlayers.matchId} = ${match.id} AND ${matchPlayers.userId} = ${userId}`);

  await publishRoster(match.id);
  return c.json({ ok: true });
});

// ─── POST /rooms/:code/ready ──────────────────────────────────────────────────

roomActionsRoutes.post('/rooms/:code/ready', async (c) => {
  const code = c.req.param('code');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const handle = typeof body.user === 'string' ? body.user.trim() : null;

  if (!handle) return c.json({ error: 'user required' }, 400);

  const match = await findMatch(code);
  if (!match) return c.json({ error: 'match not found' }, 404);

  const d = db();
  const userRows = await d.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE handle = ${handle} LIMIT 1`,
  );
  const userId = (userRows[0] as { id: string } | undefined)?.id;
  if (!userId) return c.json({ error: 'user not found' }, 404);

  // Toggle: fetch current state then flip it.
  const current = await d
    .select({ ready: matchPlayers.ready })
    .from(matchPlayers)
    .where(sql`${matchPlayers.matchId} = ${match.id} AND ${matchPlayers.userId} = ${userId}`)
    .limit(1);

  if (current.length === 0) return c.json({ error: 'not in match' }, 400);

  const newReady = !current[0]?.ready;

  await d
    .update(matchPlayers)
    .set({ ready: newReady })
    .where(sql`${matchPlayers.matchId} = ${match.id} AND ${matchPlayers.userId} = ${userId}`);

  await publishRoster(match.id);
  return c.json({ ok: true, ready: newReady });
});

// ─── POST /rooms/:code/start ──────────────────────────────────────────────────

roomActionsRoutes.post('/rooms/:code/start', async (c) => {
  const code = c.req.param('code');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const handle = typeof body.user === 'string' ? body.user.trim() : null;

  if (!handle) return c.json({ error: 'user required' }, 400);

  const match = await findMatch(code);
  if (!match) return c.json({ error: 'match not found' }, 404);

  // Only allow starting from lobby state.
  if (match.status !== 'lobby') {
    return c.json({ error: 'match already started' }, 400);
  }

  const d = db();

  // Verify the user exists (host check — until auth lands, any player can start).
  const userRows = await d.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE handle = ${handle} LIMIT 1`,
  );
  const userId = (userRows[0] as { id: string } | undefined)?.id;
  if (!userId) return c.json({ error: 'user not found' }, 404);

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
