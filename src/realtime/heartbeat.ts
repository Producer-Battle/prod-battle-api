// Tick loop heartbeat. The leader replica writes `tick:heartbeat` to Redis
// every tick; any replica (or external probe via /health/tick) can read it
// to detect that the global tick loop has stalled.
//
// Why this exists: leader election via Redis TTL (see leader.ts) means a
// stuck leader holds the lock for up to LEADER_LOCK_TTL_SEC before another
// replica takes over. If the leader process is wedged but its Redis client
// is still renewing the lock, no replica will take over and every live
// match freezes. The heartbeat catches that case from outside the renewal
// path.
//
// TTL is set generously (60s, >> the 5s staleness threshold) so a brief
// Redis blip or leader handoff doesn't evict the key faster than a probe
// can read it. Staleness is judged by ageMs, not key presence.

import { leaderClient } from './leader.js';

const HEARTBEAT_KEY = 'tick:heartbeat';
const HEARTBEAT_TTL_SEC = 60;

export async function writeTickHeartbeat(): Promise<void> {
  await leaderClient().set(HEARTBEAT_KEY, new Date().toISOString(), 'EX', HEARTBEAT_TTL_SEC);
}

export interface TickHeartbeat {
  lastTickAt: string;
  ageMs: number;
}

export async function readTickHeartbeat(): Promise<TickHeartbeat | null> {
  const raw = await leaderClient().get(HEARTBEAT_KEY);
  if (!raw) return null;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return { lastTickAt: raw, ageMs: Date.now() - at };
}
