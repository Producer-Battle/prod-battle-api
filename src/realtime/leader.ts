// Redis-based leader election.
// Pattern: SET leader:tick <id> NX EX <LEADER_LOCK_TTL_SEC>; renew every
// LEADER_RENEW_INTERVAL_MS while alive. On loss (renew fails), handler
// stops calling the tick loop.

import Redis from 'ioredis';
import { env } from '../env.js';

// Exported so the watchdog can derive its staleness threshold from the
// same number - if the lock TTL changes, /health/tick auto-tracks.
export const LEADER_LOCK_TTL_SEC = 5;
const LEADER_RENEW_INTERVAL_MS = 2000;

let _leaderClient: Redis | null = null;

// Exported so siblings in the same lifecycle (heartbeat.ts) can reuse the
// connection instead of opening a third one.
export function leaderClient(): Redis {
  if (!_leaderClient) {
    const url = env.REDIS_URL ?? 'redis://localhost:6379';
    _leaderClient = new Redis(url, {
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      maxRetriesPerRequest: null,
    });
    _leaderClient.on('error', (err: Error) => {
      console.error('[leader] redis error:', err.message);
    });
  }
  return _leaderClient;
}

function randomId(): string {
  return `${process.pid}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Attempt to acquire `key` as leader, then call `onBecomeLeader`.
 * Renews every 2s; if renewal fails (another process took over),
 * stops renewing and never calls `onBecomeLeader` again until the
 * next acquisition cycle (handled by the caller - see tick.ts).
 *
 * Returns a stop function that cancels the election loop.
 */
export function runAsLeader(key: string, onBecomeLeader: () => Promise<void>): () => void {
  const id = randomId();
  const client = leaderClient();
  let stopped = false;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  let isLeader = false;

  async function tryAcquire(): Promise<void> {
    if (stopped) return;
    try {
      const result = await client.set(key, id, 'EX', LEADER_LOCK_TTL_SEC, 'NX');
      if (result === 'OK') {
        isLeader = true;
        console.log(`[leader] acquired ${key}`);
        await onBecomeLeader();
      }
    } catch (err) {
      // network hiccup - not leader, will retry
    }
  }

  async function renew(): Promise<void> {
    if (stopped) {
      if (renewTimer) clearInterval(renewTimer);
      return;
    }
    if (!isLeader) {
      // Try to acquire if we don't hold it
      await tryAcquire();
      return;
    }
    try {
      // Only renew if we still own the key
      const current = await client.get(key);
      if (current !== id) {
        console.log(`[leader] lost ${key}`);
        isLeader = false;
        return;
      }
      await client.expire(key, LEADER_LOCK_TTL_SEC);
    } catch {
      // treat as loss on error
      isLeader = false;
    }
  }

  tryAcquire().catch(() => {});
  renewTimer = setInterval(() => {
    renew().catch(() => {});
  }, LEADER_RENEW_INTERVAL_MS);

  return () => {
    stopped = true;
    if (renewTimer) clearInterval(renewTimer);
  };
}
