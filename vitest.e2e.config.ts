import { defineConfig } from 'vitest/config';

// End-to-end mode-per-file suite.
// Requires a running Postgres (DATABASE_URL) with migrations applied.
// ioredis and the S3 presigner are mocked in src/tests/setup.ts, so no
// Redis or S3 is needed.
// Run sequentially (single fork) because every file shares the same DB.
export default defineConfig({
  test: {
    include: ['src/tests/e2e/**/*.test.ts'],
    setupFiles: ['src/tests/setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
