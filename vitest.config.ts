import { defineConfig } from 'vitest/config';

// Unit tests only. Fast, no external services required.
// E2E tests live in src/tests/e2e/** and run via `pnpm test:e2e`
// against vitest.e2e.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/tests/e2e/**', 'src/tests/integration/**', 'node_modules', 'dist'],
    passWithNoTests: true,
  },
});
