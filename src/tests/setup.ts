// Global mocks applied to every e2e test file via vitest.e2e.config.ts
// setupFiles. Keeps the suite fast and hermetic:
//   - ioredis: in-memory no-op client. pubsub publish resolves; rate-limit
//     incr returns 1 (under the anon quota) so match creation is allowed.
//   - @aws-sdk/s3-request-presigner: returns a stable fake signed URL
//     without touching any S3 endpoint.
// Nothing here depends on real services, so the tests run anywhere Node +
// Postgres are available.

import { vi } from 'vitest';

vi.mock('ioredis', () => {
  class FakeRedis {
    private store = new Map<string, number>();
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
