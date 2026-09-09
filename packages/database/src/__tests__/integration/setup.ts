import { describe } from 'vitest';

import { createDatabaseClient, type DatabaseClient } from '../../client';

/**
 * Integration test harness.
 *
 * These tests talk to a real PostgreSQL, because the things they verify —
 * unique constraints, CHECK constraints, cascade deletes, `date` column
 * semantics, enum storage — do not exist anywhere else. A mock would only assert
 * that the mock behaves like the mock.
 *
 * They are opt-in: without `TEST_DATABASE_URL` (or `DATABASE_URL`) the whole
 * suite is skipped, so `pnpm test` still runs on a clean checkout with no
 * services. `docker compose up -d postgres` provides a database.
 */

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

export const hasDatabase = TEST_DATABASE_URL.length > 0;

/**
 * `describe` that skips the whole block when no database is configured.
 *
 * Written as a plain function rather than `describe.skipIf(...)` so the exported
 * type is nameable: re-exporting Vitest's chainable suite type breaks
 * declaration emit.
 */
export const describeIntegration = (name: string, factory: () => void): void => {
  if (hasDatabase) {
    describe(name, factory);
    return;
  }

  describe.skip(name, factory);
};

/** Emails in this domain mark rows the suite owns and may delete. */
export const TEST_EMAIL_DOMAIN = 'itest.local';

let sequence = 0;

/** A unique, recognisable email for one test's fixture user. */
export const testEmail = (label: string): string => {
  sequence += 1;
  return `${label}-${sequence}@${TEST_EMAIL_DOMAIN}`;
};

export const createTestClient = (): DatabaseClient => {
  // `loadDatabaseEnv` reads `DATABASE_URL`; point it at the test database so the
  // client is built through exactly the same path production uses.
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  return createDatabaseClient({ connectionString: TEST_DATABASE_URL });
};

/**
 * Removes everything the suite created.
 *
 * Deleting the users is enough: every owned table cascades from `users`, which
 * is also a live assertion that the cascade rules are wired correctly.
 */
export const cleanupTestData = async (db: DatabaseClient): Promise<void> => {
  await db.user.deleteMany({ where: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } });
};
