import type { Logger } from '@space/logger';

import type { PrismaClient } from './client';

/**
 * Database reachability, for platform health checks.
 *
 * The result carries no connection details, no error text and no schema
 * information. A health endpoint is usually unauthenticated, so it says whether
 * the database answered and how long it took — nothing that helps an attacker
 * map the deployment. The underlying error is logged, where it is useful and
 * not public.
 */

export type DatabaseHealthStatus = 'ok' | 'unreachable';

export interface DatabaseHealth {
  status: DatabaseHealthStatus;
  latencyMs: number;
}

export interface DatabaseHealthOptions {
  /** How long to wait before declaring the database unreachable. */
  timeoutMs?: number;
  logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Runs the cheapest possible round trip.
 *
 * `SELECT 1` touches no table, so the probe stays valid even mid-migration, and
 * it cannot be starved by a lock on application data.
 */
export const checkDatabaseHealth = async (
  client: PrismaClient,
  { timeoutMs = DEFAULT_TIMEOUT_MS, logger }: DatabaseHealthOptions = {},
): Promise<DatabaseHealth> => {
  const startedAt = performance.now();

  const timeout = new Promise<'timeout'>((resolve) => {
    const timer = setTimeout(() => {
      resolve('timeout');
    }, timeoutMs);
    // A pending probe must never hold a shutting-down process open.
    timer.unref?.();
  });

  try {
    const outcome = await Promise.race([
      client.$queryRaw`SELECT 1`.then(() => 'ok' as const),
      timeout,
    ]);

    const latencyMs = Math.round(performance.now() - startedAt);

    if (outcome === 'timeout') {
      logger?.warn({ timeoutMs }, 'database health probe timed out');
      return { status: 'unreachable', latencyMs };
    }

    return { status: 'ok', latencyMs };
  } catch (error) {
    logger?.error({ err: error }, 'database health probe failed');
    return { status: 'unreachable', latencyMs: Math.round(performance.now() - startedAt) };
  }
};
