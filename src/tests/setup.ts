// Global mocks applied to every e2e test file via vitest.e2e.config.ts
// setupFiles. Keeps the suite fast and hermetic:
//   - ioredis: in-memory no-op client. pubsub publish resolves; rate-limit
//     incr returns 1 (under the anon quota) so match creation is allowed.
//   - @aws-sdk/s3-request-presigner: returns a stable fake signed URL
//     without touching any S3 endpoint.
// Nothing here depends on real services, so the tests run anywhere Node +
// Postgres are available.

import { beforeEach, vi } from 'vitest';

vi.mock('ioredis', () => {
  class FakeRedis {
    private store = new Map<string, number>();
    constructor() {
      // Register every instance so the beforeEach below can wipe rate-limit
      // counters between tests. Needed since the harness cookie jar landed:
      // one test app now presents ONE stable pb_anon identity, so counters
      // like rl:match:create:<anonId> accumulate across tests in a file and
      // trip the 3-matches/day free-tier limit.
      const g = globalThis as unknown as { __fakeRedisInstances?: Set<FakeRedis> };
      g.__fakeRedisInstances ??= new Set();
      g.__fakeRedisInstances.add(this);
    }
    __reset() {
      this.store.clear();
    }
    on() {
      return this;
    }
    connect() {
      return Promise.resolve();
    }
    quit() {
      return Promise.resolve('OK');
    }
    async incr(key: string): Promise<number> {
      const n = (this.store.get(key) ?? 0) + 1;
      this.store.set(key, n);
      return n;
    }
    expire() {
      return Promise.resolve(1);
    }
    ttl() {
      return Promise.resolve(-1);
    }
    publish() {
      return Promise.resolve(0);
    }
    subscribe() {
      return Promise.resolve();
    }
    unsubscribe() {
      return Promise.resolve();
    }
    get() {
      return Promise.resolve(null);
    }
    set() {
      return Promise.resolve('OK');
    }
    del() {
      return Promise.resolve(0);
    }
    eval() {
      return Promise.resolve(null);
    }
    zadd() {
      return Promise.resolve(1);
    }
    zrange() {
      return Promise.resolve([]);
    }
    zrem() {
      return Promise.resolve(0);
    }
  }
  return { default: FakeRedis };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://s3.fake/signed?sig=test'),
}));

// Wipe FakeRedis counters between tests (see the constructor note above).
beforeEach(() => {
  const g = globalThis as unknown as { __fakeRedisInstances?: Set<{ __reset(): void }> };
  for (const r of g.__fakeRedisInstances ?? []) r.__reset();
});
