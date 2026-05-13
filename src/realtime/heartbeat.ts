// Tick loop heartbeat. The leader replica writes `tick:heartbeat` to Redis
// every tick; any replica (or external probe via /health/tick) can read it
// to detect that the global tick loop has stalled.
//
// Why this exists: leader election via Redis TTL (see leader.ts) means a
// stuck leader holds the lock for up to 5s before another replica takes
// over. If the leader process is wedged but its Redis client is still
// renewing the lock, no replica will take over and every live match
// freezes. The heartbeat catches that case from outside the renewal path.

import Redis from 'ioredis';
import { env } from '../env.js';

const HEARTBEAT_KEY = 'tick:heartbeat';
const HEARTBEAT_TTL_SEC = 60;

let _client: Redis | null = null;

function client(): Redis {
  if (!_client) {
    const url = env.REDIS_URL ?? 'redis://localhost:6379';
    _client = new Redis(url, {
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      maxRetriesPerRequest: null,
    });
    _client.on('error', (err: Error) => {
      console.error('[heartbeat] redis error:', err.message);
    });
  }
  return _client;
}

export async function writeTickHeartbeat(): Promise<void> {
  await client().set(HEARTBEAT_KEY, new Date().toISOString(), 'EX', HEARTBEAT_TTL_SEC);
}

export interface TickHeartbeat {
  lastTickAt: string;
  ageMs: number;
}

export async function readTickHeartbeat(): Promise<TickHeartbeat | null> {
  const raw = await client().get(HEARTBEAT_KEY);
  if (!raw) return null;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return { lastTickAt: raw, ageMs: Date.now() - at };
}
