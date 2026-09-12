import { booleanFromEnvSchema, nonEmptyStringSchema } from '@space/validation';
import { z } from 'zod';

import { assertServerRuntime, defineEnv, type EnvSource } from './define-env';
import { nodeEnvSchema } from './node-env';

const SCOPE = '@space/database';

/**
 * A PostgreSQL connection string.
 *
 * Validated by shape only. It is never logged, never returned from a health
 * check, and never crosses into a client bundle — the schema lives here, beside
 * the other server-only environments, rather than in the database package, so
 * every runtime keeps a single way of reading configuration.
 */
const postgresUrlSchema = nonEmptyStringSchema.refine(
  (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
  { message: 'must be a postgres:// or postgresql:// connection string' },
);

export const databaseEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,

  /**
   * Pooled connection used by the applications.
   *
   * On Supabase this is the PgBouncer endpoint (port 6543). Transaction pooling
   * does not support prepared statements, which is why the schema also asks for
   * a direct URL for migrations.
   */
  DATABASE_URL: postgresUrlSchema,

  /**
   * Direct, unpooled connection used by `prisma migrate` and introspection.
   *
   * Optional: it falls back to `DATABASE_URL` for local development, where the
   * two are the same server.
   */
  DIRECT_DATABASE_URL: postgresUrlSchema.optional(),

  /**
   * Emit one log record per SQL statement.
   *
   * Off by default and intended for local debugging only. Statement text is
   * logged without parameters, so user content and credentials never reach the
   * log stream.
   */
  DATABASE_LOG_QUERIES: booleanFromEnvSchema.default(false),

  /** Milliseconds a health probe may wait before declaring the database unreachable. */
  DATABASE_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
});

export type DatabaseEnv = z.output<typeof databaseEnvSchema>;

/** Loads and validates the database environment. Throws on the first bad value. */
export const loadDatabaseEnv = (source?: EnvSource): Readonly<DatabaseEnv> => {
  assertServerRuntime(SCOPE);
  return defineEnv(SCOPE, databaseEnvSchema, source);
};
