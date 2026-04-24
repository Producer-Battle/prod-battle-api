import { defineConfig } from 'vitest/config';

// Real-S3 integration tier.
// Requires a running Postgres (DATABASE_URL) with migrations applied and a
// real S3-compatible endpoint (S3_ENDPOINT, S3_BUCKET, etc.).
// No setupFiles - ioredis and the S3 presigner are NOT mocked here; the
// tests exercise actual presigned URL generation and real object fetches.
// Run in a single fork because tests share the same DB and MinIO bucket.
export default defineConfig({
  test: {
    include: ['src/tests/integration/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
