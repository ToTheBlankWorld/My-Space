import { defineConfig } from 'vitest/config';

/**
 * Integration tests.
 *
 * These require a real PostgreSQL database, named by `TEST_DATABASE_URL` (or
 * `DATABASE_URL`). They are excluded from `pnpm test` on purpose: the ordinary
 * unit suite must run on a clean checkout with no services.
 *
 * `docker compose up -d postgres` at the repository root provides one.
 */
export default defineConfig({
  test: {
    name: 'database:integration',
    environment: 'node',
    include: ['src/**/integration/**/*.test.ts'],
    // One connection pool, one schema: the suites share a database and clean up
    // after themselves, so they must not interleave.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
