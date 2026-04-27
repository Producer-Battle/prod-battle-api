// Per-match player presence in Redis. Refreshed on every WS message
// from the player. Tick worker scans active matches and marks players
// abandoned if their presence key has expired (i.e. no activity for
// graceSeconds).
//
// Key format:  presence:<matchId>:<userId>
// Value:       last-seen ISO timestamp (for debugging; existence is the signal)
// TTL:         graceSeconds + 30 (slack so the tick scan reliably notices
//              the missing key before the player can drift further)
//
// Fail-open: if Redis is unavailable, presence checks return "present" so
// we don't false-positive abandons on infrastructure hiccups. Better to
// miss an abandon than punish a player for our outage.

import Redis from 'ioredis';
import { env } from '../env.js';
import { getCategory } from '../game-rules/loader.js';

let _client: Redis | null = null;

function getRedis(): Redis {
  if (!_client) {
    const url = env.REDIS_URL ?? 'redis://localhost:6379';
    _client = new Redis(url, {
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      maxRetriesPerRequest: 1,
    });
    _client.on('error', (err: Error) => {
      console.warn('[presence] redis error:', err.message);
    });
  }
  return _client;
}

function key(matchId: string, userId: string): string {
  return `presence:${matchId}:${userId}`;
}

export async function markPresent(matchId: string, userId: string): Promise<void> {
  const rules = await getCategory('reconnect').catch(() => ({ graceSeconds: 120 }) as never);
  const grace = (rules as { graceSeconds: number }).graceSeconds;
  const ttl = grace + 30;
  try {
    await getRedis().set(key(matchId, userId), new Date().toISOString(), 'EX', ttl);
  } catch (err) {
    console.warn('[presence] markPresent failed:', (err as Error).message);
  }
}

export async function isPresent(matchId: string, userId: string): Promise<boolean> {
  try {
    const v = await getRedis().exists(key(matchId, userId));
    return v === 1;
  } catch (err) {
    console.warn('[presence] isPresent failed (fail-open):', (err as Error).message);
    return true;
  }
}

export async function clearPresence(matchId: string, userId: string): Promise<void> {
  try {
    await getRedis().del(key(matchId, userId));
  } catch (err) {
    console.warn('[presence] clearPresence failed:', (err as Error).message);
  }
}

// Test-only: reset the lazy singleton so tests can swap REDIS_URL.
export function _resetForTest(): void {
  _client = null;
}
