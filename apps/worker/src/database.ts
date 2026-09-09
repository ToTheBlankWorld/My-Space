import { checkDatabaseHealth, createDatabaseClient, type DatabaseClient } from '@space/database';
import type { Logger } from '@space/logger';

import type { ReadinessProbe } from './health/server';

/**
 * The worker's optional database connection.
 *
 * `DATABASE_URL` is not required to boot. This stage has no queue consumers and
 * no scheduled work, and a developer must be able to run the process without
 * standing up PostgreSQL first. When the variable *is* present the worker opens
 * a pool and reports the database through `/readyz`, so a rolling deploy stops
 * sending work to an instance that cannot reach its data.
 */

export interface DatabaseConnection {
  client: DatabaseClient;
  probe: ReadinessProbe;
  dispose: () => Promise<void>;
}

export interface ConnectDatabaseOptions {
  connectionString: string;
  logger: Logger;
  /** How long a readiness probe may wait before reporting the database down. */
  healthTimeoutMs?: number;
}

export const connectDatabase = ({
  connectionString,
  logger,
  healthTimeoutMs = 2_000,
}: ConnectDatabaseOptions): DatabaseConnection => {
  const client = createDatabaseClient({ connectionString, logger });

  return {
    client,
    probe: async () => {
      const health = await checkDatabaseHealth(client, { timeoutMs: healthTimeoutMs, logger });
      return { name: 'database', ok: health.status === 'ok' };
    },
    // Draining the pool is part of graceful shutdown: an abrupt exit leaves
    // server-side connections to time out on their own.
    dispose: () => client.$disconnect(),
  };
};
