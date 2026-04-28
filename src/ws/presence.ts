// Site-wide presence WebSocket. Replaces the /stats/live HTTP poll with a
// push channel: each connected tab maintains a WS, the server keeps an
// in-memory set of connected identities, and broadcasts the current count
// whenever it changes (or every 5s as a heartbeat for clients that joined
// during a quiet period).
//
// Connection identity:
//   - signed-in: userId  (3 tabs same account = 1 entry)
//   - guest:     a randomly-generated id per connection (no stable client
//                identity available; multiple anonymous tabs from one
//                person count separately, which is acceptable for v0)
//
// Multi-instance caveat: the count is per-process. With Scaleway max_scale
// = 5, that's at-worst a 5x undercount per instance. Good enough for the
// pill; upgrade to Redis pub/sub broadcast if/when accuracy matters.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { countDistinct, inArray } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { db } from '../db/client.js';
import { matches } from '../db/schema.js';

type Identity = string; // userId or guest:<uuid>

// One entry per *identity*; each entry holds the set of sockets attached
// to that identity. Tabs from the same logged-in user collapse into one
// entry, so the count is the size of this map.
const presenceByIdentity = new Map<Identity, Set<WebSocket>>();

// Throttle broadcasts to at most once per 250ms when bursts of connects
// happen. The heartbeat below covers the steady-state case.
let broadcastQueued = false;
let lastBroadcastedPayload = '';

const HEARTBEAT_MS = 5_000;
const LIVE_STATUSES = ['lobby', 'submit', 'reveal', 'vote'] as const;

async function liveBattleCount(): Promise<number> {
  try {
    const rows = await db()
      .select({ n: countDistinct(matches.id) })
      .from(matches)
      .where(
        inArray(
          matches.status,
          LIVE_STATUSES as readonly (typeof LIVE_STATUSES)[number][] as (typeof LIVE_STATUSES)[number][],
        ),
      );
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

async function buildPayload(): Promise<string> {
  const live = presenceByIdentity.size;
  const battles = await liveBattleCount();
  return JSON.stringify({ type: 'presence', live, battles });
}

async function broadcast(): Promise<void> {
  if (broadcastQueued) return;
  broadcastQueued = true;
  // Microtask defer: coalesce simultaneous connect/disconnect into one send.
  await new Promise((r) => setTimeout(r, 0));
  broadcastQueued = false;

  const payload = await buildPayload();
  if (payload === lastBroadcastedPayload) return;
  lastBroadcastedPayload = payload;
  for (const sockets of presenceByIdentity.values()) {
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }
}

// Heartbeat: refresh battles count + re-send to anyone connected. Catches
// the case where a battle starts/ends without a presence change.
setInterval(() => {
  // Force a broadcast even if the cached payload would be the same; battle
  // count can change while presence didn't.
  lastBroadcastedPayload = '';
  void broadcast();
}, HEARTBEAT_MS).unref();

// Read the session cookie off the upgrade request and resolve to a userId.
// Defers to better-auth's session validator. Returns null on no/bad cookie.
async function userIdFromCookie(req: IncomingMessage): Promise<string | null> {
  try {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;
    const { auth } = await import('../auth/config.js');
    // better-auth's getSession reads the cookie from a Headers-like object.
    const headers = new Headers();
    headers.set('cookie', cookieHeader);
    const result = await auth.api.getSession({ headers });
    return result?.user?.id ?? null;
  } catch {
    return null;
  }
}

function fpFromUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl, 'http://localhost');
    const fp = u.searchParams.get('fp');
    if (fp && fp.length >= 8 && fp.length <= 200) return fp;
  } catch {}
  return null;
}

export async function handlePresenceConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const userId = await userIdFromCookie(req);
  // Identity hierarchy: signed-in userId beats fingerprint beats per-conn
  // random uuid. Multiple tabs from one logged-in user collapse to one
  // entry; multiple guest tabs from one device (same fingerprint) also
  // collapse; guest tabs without a fingerprint are counted separately.
  const fp = fpFromUrl(req.url);
  const identity: Identity = userId ?? (fp ? `fp:${fp}` : `guest:${randomUUID()}`);

  let sockets = presenceByIdentity.get(identity);
  if (!sockets) {
    sockets = new Set();
    presenceByIdentity.set(identity, sockets);
  }
  sockets.add(ws);

  // Push the current count immediately so the pill renders without waiting
  // for the heartbeat tick.
  ws.send(await buildPayload());

  // Re-broadcast if this was the first socket for this identity (count
  // actually changed). A second tab from the same user doesn't change the
  // count - so no broadcast for those.
  if (sockets.size === 1) void broadcast();

  const cleanup = () => {
    const set = presenceByIdentity.get(identity);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      presenceByIdentity.delete(identity);
      void broadcast();
    }
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

// Test/admin helper - exposed so the rest of the app can call broadcast()
// when something else changes (a match starts/ends in real time). Currently
// unused; the heartbeat catches it.
export function broadcastPresence(): void {
  lastBroadcastedPayload = '';
  void broadcast();
}
