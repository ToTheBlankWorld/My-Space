import { PrismaPg } from '@prisma/adapter-pg';
import { assertServerRuntime } from '@space/config';
import { loadDatabaseEnv } from '@space/config/database';
import type { Logger } from '@space/logger';

import { type Prisma, PrismaClient } from './generated/prisma/client';

/**
 * The Prisma client, and the rules for owning one.
 *
 * This module is server-only. It is never imported by a browser bundle: the web
 * application reaches it through `apps/web/src/server/database.ts`, which is
 * marked with `server-only` so that a bad import fails the build rather than
 * shipping a connection string to a browser. `assertServerRuntime` is the
 * belt-and-braces runtime check, reusing the Stage 1 guard rather than inventing
 * a second one.
 */

/**
 * Prisma's log configuration.
 *
 * Every level is registered as an event, including `query`, so the client's type
 * is a constant and `$on('query')` always type-checks. Whether anything
 * subscribes to query events is decided at runtime.
 */
const LOG_CONFIG = [
  { emit: 'event', level: 'query' },
  { emit: 'event', level: 'info' },
  { emit: 'event', level: 'warn' },
  { emit: 'event', level: 'error' },
] as const;

// The return type is inferred rather than annotated: Prisma derives which log
// events the client emits from the literal `log` option, and spelling that type
// out by hand would immediately drift.
const construct = (adapter: PrismaPg) => new PrismaClient({ adapter, log: [...LOG_CONFIG] });

/** A fully configured client, with its own connection pool. */
export type DatabaseClient = ReturnType<typeof construct>;

/**
 * A database handle: either a client or a transaction.
 *
 * Repositories accept this type so the same function body runs inside
 * `$transaction` and outside it. A full client is assignable to it.
 */
export type Database = Prisma.TransactionClient;

export type { PrismaClient };

export interface DatabaseClientOptions {
  /**
   * PostgreSQL connection string. Defaults to `DATABASE_URL` from the validated
   * environment.
   */
  connectionString?: string;
  /** Where Prisma's own events are forwarded. Without one, they are dropped. */
  logger?: Logger;
  /**
   * Emit one record per SQL statement.
   *
   * Statement *text* is logged; parameters never are. Prisma's query events
   * include bound parameters, which routinely contain user content and would
   * contain credentials the moment an auth table exists.
   */
  logQueries?: boolean;
}

/**
 * Creates a new client with its own connection pool.
 *
 * Prefer {@link getDatabaseClient} in application code — a process should have
 * one pool. This factory exists for tests and for scripts that need an isolated
 * connection they can close.
 */
export const createDatabaseClient = (options: DatabaseClientOptions = {}): DatabaseClient => {
  assertServerRuntime('@space/database');

  const env = loadDatabaseEnv();
  const connectionString = options.connectionString ?? env.DATABASE_URL;
  const logQueries = options.logQueries ?? env.DATABASE_LOG_QUERIES;
  const { logger } = options;

  // The driver adapter owns the pool. Prisma 7 has no query engine binary, so
  // the connection string never leaves this process boundary.
  const adapter = new PrismaPg({ connectionString });

  const client = construct(adapter);

  if (logger) {
    attachLogging(client, logger, logQueries);
  }

  return client;
};

/**
 * Forwards Prisma's events into the shared structured logger.
 *
 * Deliberately narrow: durations and statement text are operational data, while
 * `event.params` is user data and is never read.
 */
const attachLogging = (client: DatabaseClient, logger: Logger, logQueries: boolean): void => {
  const databaseLogger = logger.child({ component: 'database' });

  if (logQueries) {
    client.$on('query', (event) => {
      databaseLogger.debug({ durationMs: event.duration, query: event.query }, 'sql');
    });
  }

  client.$on('info', (event) => {
    databaseLogger.info({ target: event.target }, event.message);
  });

  client.$on('warn', (event) => {
    databaseLogger.warn({ target: event.target }, event.message);
  });

  client.$on('error', (event) => {
    databaseLogger.error({ target: event.target }, event.message);
  });
};

/**
 * Process-wide client cache.
 *
 * Held on `globalThis` because Next.js replaces module instances on every hot
 * reload; without this, a development session opens a new pool per edit and
 * exhausts the database's connection limit within minutes. In production the
 * module is evaluated once and the global is simply where the single instance
 * lives.
 */
const globalCache = globalThis as typeof globalThis & {
  __spaceDatabaseClient?: DatabaseClient;
};

/** Returns the shared client, creating it on first use. */
export const getDatabaseClient = (options: DatabaseClientOptions = {}): DatabaseClient => {
  globalCache.__spaceDatabaseClient ??= createDatabaseClient(options);
  return globalCache.__spaceDatabaseClient;
};

/**
 * Closes the shared client, if one was created.
 *
 * Called from a worker's shutdown sequence. Serverless request handlers should
 * *not* call this: the pool is meant to outlive a single invocation.
 */
export const disconnectDatabase = async (): Promise<void> => {
  const client = globalCache.__spaceDatabaseClient;
  if (!client) {
    return;
  }

  globalCache.__spaceDatabaseClient = undefined;
  await client.$disconnect();
};
