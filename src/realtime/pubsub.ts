// Redis pub/sub wrapper.
// Uses ioredis: one subscriber client per process (shared), one publisher.
// Channels: `battle:{matchId}` for match events; `queue:{genreSlug}` for
// quickplay matchmaking notifications; `system` for global admin events.

import Redis from 'ioredis';
import { env } from '../env.js';

let _publisher: Redis | null = null;
let _subscriber: Redis | null = null;

function makeClient(): Redis {
  const url = env.REDIS_URL ?? 'redis://localhost:6379';
  const client = new Redis(url, {
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 100, 3000),
    maxRetriesPerRequest: null,
  });
  client.on('error', (err: Error) => {
    console.error('[pubsub] redis error:', err.message);
  });
  return client;
}

function publisher(): Redis {
  if (!_publisher) {
    _publisher = makeClient();
  }
  return _publisher;
}

function subscriber(): Redis {
  if (!_subscriber) {
    _subscriber = makeClient();
  }
  return _subscriber;
}

/** Map of channel → set of handlers registered on this process. */
const handlers = new Map<string, Set<(payload: unknown) => void>>();

/** Boot the subscriber once and route inbound messages. */
let subscriberBooted = false;
function bootSubscriber(): void {
  if (subscriberBooted) return;
  subscriberBooted = true;
  const sub = subscriber();
  sub.on('message', (channel: string, raw: string) => {
    const set = handlers.get(channel);
    if (!set || set.size === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return; // ignore malformed
    }
    for (const fn of set) {
      try {
        fn(payload);
      } catch {
        // individual handler errors must not crash the loop
      }
    }
  });
}

export async function publish(channel: string, payload: unknown): Promise<void> {
  await publisher().publish(channel, JSON.stringify(payload));
}

export function subscribe(channel: string, handler: (payload: unknown) => void): () => void {
  bootSubscriber();
  if (!handlers.has(channel)) {
    handlers.set(channel, new Set());
    subscriber()
      .subscribe(channel)
      .catch((err: Error) => console.error('[pubsub] subscribe error:', err.message));
  }
  handlers.get(channel)?.add(handler);

  return () => {
    const set = handlers.get(channel);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      handlers.delete(channel);
      subscriber()
        .unsubscribe(channel)
        .catch((err: Error) => console.error('[pubsub] unsubscribe error:', err.message));
    }
  };
}

/** Graceful shutdown — called from server.ts if needed. */
export async function closePubSub(): Promise<void> {
  await Promise.all([_publisher?.quit(), _subscriber?.quit()]);
}
