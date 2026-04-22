// WebSocket upgrade entry point.
// Wires /ws/match/:code upgrades onto the HTTP server from server.ts.
// Auth: reads session cookie, asserts user is a match_player for :id.
// Delegates to ./room.ts for per-match session handling.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { WebSocketServer } from 'ws';
import { db } from '../db/client.js';
import { matchPlayers, matchTeams, matches } from '../db/schema.js';
import { publish } from '../realtime/pubsub.js';
import { MatchSession } from './room.js';

/** Parse the URL path to extract the room code from /ws/match/:code */
function parseRoomCode(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/^\/ws\/match\/([^/?#]+)/);
  return match ? (match[1] ?? null) : null;
}

/** Extract the ?user= query param (guest identity until auth lands). */
function parseUserId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    // Node req.url is path+query only, so we need a base to parse it.
    const parsed = new URL(url, 'http://localhost');
    const user = parsed.searchParams.get('user');
    if (user && user.trim().length > 0) return user.trim();
  } catch {
    // ignore parse errors
  }
  return null;
}

/** Ensure a user row exists (guest stub — real auth agent will replace). */
async function ensureGuestUser(handle: string): Promise<string> {
  const d = db();
  const rows = await d.execute<{ id: string }>(
    sql`INSERT INTO users (id, email, handle, role)
        VALUES (gen_random_uuid(), ${handle || 'guest'} || '@guest.local', ${handle || 'guest'}, 'producer')
        ON CONFLICT (handle) DO UPDATE SET handle = EXCLUDED.handle
        RETURNING id`,
  );
  const row = rows[0] as { id: string } | undefined;
  return row?.id ?? randomUUID();
}

/** Find match by roomCode. */
async function findMatch(code: string) {
  const d = db();
  const [row] = await d.select().from(matches).where(eq(matches.roomCode, code)).limit(1);
  return row ?? null;
}

/** Seat the player in the next available team slot (round-robin). */
async function seatPlayer(matchId: string, userId: string): Promise<void> {
  const d = db();

  // Check if already seated.
  const existing = await d
    .select()
    .from(matchPlayers)
    .where(sql`${matchPlayers.matchId} = ${matchId} AND ${matchPlayers.userId} = ${userId}`)
    .limit(1);

  if (existing.length > 0) return; // already in

  // Find teams for this match ordered by seat.
  const teams = await d
    .select()
    .from(matchTeams)
    .where(eq(matchTeams.matchId, matchId))
    .orderBy(matchTeams.seat);

  if (teams.length === 0) return;

  // Count how many players are seated per team.
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

  // Pick the team with the fewest members (round-robin).
  // teams.length > 0 is checked above, so we can safely reduce.
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

type RosterRow = {
  user_id: string;
  handle: string;
  team_id: string | null;
  team_seat: number | null;
  team_name: string | null;
  ready: boolean;
};

/** Build and publish a roster event for a match. */
export async function publishRoster(matchId: string): Promise<void> {
  const d = db();

  const rows = await d.execute<RosterRow>(
    sql`SELECT
          mp.user_id,
          u.handle,
          mp.team_id,
          mt.seat AS team_seat,
          mt.name AS team_name,
          mp.ready
        FROM match_players mp
        JOIN users u ON u.id = mp.user_id
        LEFT JOIN match_teams mt ON mt.id = mp.team_id
        WHERE mp.match_id = ${matchId}
          AND mp.is_spectator = false
        ORDER BY mt.seat, u.handle`,
  );

  // Deduplicate teams from the flat rows.
  const teamMap = new Map<string, { id: string; seat: number; name: string | null }>();
  for (const row of rows) {
    if (row.team_id && !teamMap.has(row.team_id)) {
      teamMap.set(row.team_id, {
        id: row.team_id,
        seat: row.team_seat ?? 0,
        name: row.team_name ?? null,
      });
    }
  }

  const roster = {
    teams: Array.from(teamMap.values()),
    players: rows.map((r) => ({
      userId: r.user_id,
      handle: r.handle,
      teamId: r.team_id ?? null,
      ready: r.ready,
    })),
  };

  await publish(`battle:${matchId}`, { type: 'roster', roster });
}

export function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const { url } = req;
    const code = parseRoomCode(url);
    if (!code) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, async (ws) => {
      try {
        const match = await findMatch(code);
        if (!match) {
          ws.close(4004, 'match not found');
          return;
        }

        // Resolve player identity: ?user= or a generated guest id.
        const rawUser = parseUserId(url);
        const handle = rawUser ?? `guest-${randomUUID().slice(0, 8)}`;
        const userId = await ensureGuestUser(handle);

        // Seat the player.
        await seatPlayer(match.id, userId);

        // Create the session (hooks up Redis → WS forwarding).
        const session = new MatchSession(match.id, userId, ws);

        // Send the current roster immediately on connect.
        const d = db();
        const rosterRows = await d.execute<RosterRow>(
          sql`SELECT
                mp.user_id,
                u.handle,
                mp.team_id,
                mt.seat AS team_seat,
                mt.name AS team_name,
                mp.ready
              FROM match_players mp
              JOIN users u ON u.id = mp.user_id
              LEFT JOIN match_teams mt ON mt.id = mp.team_id
              WHERE mp.match_id = ${match.id}
                AND mp.is_spectator = false
              ORDER BY mt.seat, u.handle`,
        );

        const teamMap = new Map<string, { id: string; seat: number; name: string | null }>();
        for (const row of rosterRows) {
          if (row.team_id && !teamMap.has(row.team_id)) {
            teamMap.set(row.team_id, {
              id: row.team_id,
              seat: row.team_seat ?? 0,
              name: row.team_name ?? null,
            });
          }
        }

        session.send({
          type: 'roster',
          roster: {
            teams: Array.from(teamMap.values()),
            players: rosterRows.map((r) => ({
              userId: r.user_id,
              handle: r.handle,
              teamId: r.team_id ?? null,
              ready: r.ready,
            })),
          },
        });

        // Also broadcast the updated roster so other connected tabs see the join.
        await publishRoster(match.id);

        ws.on('close', async () => {
          // On disconnect, broadcast updated roster so other tabs see the departure.
          await publishRoster(match.id).catch(() => {});
        });
      } catch (err) {
        console.error('[ws] upgrade error:', err);
        ws.close(1011, 'internal error');
      }
    });
  });

  console.log('[ws] WebSocket server attached');
}
