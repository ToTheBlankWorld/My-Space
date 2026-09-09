import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '../client';
import { checkDatabaseHealth } from '../health';

/**
 * The probe is tested against a stub client: it must behave correctly when the
 * database is slow or unreachable, and neither case is worth a real outage to
 * reproduce.
 */
const stubClient = (queryRaw: () => Promise<unknown>): PrismaClient =>
  ({ $queryRaw: queryRaw }) as unknown as PrismaClient;

describe('checkDatabaseHealth', () => {
  it('reports ok with a latency when the database answers', async () => {
    const health = await checkDatabaseHealth(
      stubClient(() => Promise.resolve([{ '?column?': 1 }])),
    );

    expect(health.status).toBe('ok');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports unreachable when the query fails', async () => {
    const health = await checkDatabaseHealth(
      stubClient(() => Promise.reject(new Error('connect ECONNREFUSED'))),
    );

    expect(health.status).toBe('unreachable');
  });

  it('reports unreachable rather than hanging when the database is slow', async () => {
    vi.useFakeTimers();

    const pending = checkDatabaseHealth(
      stubClient(() => new Promise(() => undefined)),
      { timeoutMs: 50 },
    );
    await vi.advanceTimersByTimeAsync(60);

    await expect(pending).resolves.toMatchObject({ status: 'unreachable' });

    vi.useRealTimers();
  });

  it('never returns anything an unauthenticated caller could exploit', async () => {
    const health = await checkDatabaseHealth(
      stubClient(() =>
        Promise.reject(new Error('password authentication failed for user "space" at db:5432')),
      ),
    );

    // Status and latency, and nothing else: no host, no user, no error text.
    expect(Object.keys(health).sort()).toEqual(['latencyMs', 'status']);
    expect(JSON.stringify(health)).not.toContain('password');
  });

  it('logs the underlying failure where it is useful and not public', async () => {
    const error = vi.fn();
    const logger = { error, warn: vi.fn() } as unknown as Parameters<
      typeof checkDatabaseHealth
    >[1] extends undefined
      ? never
      : NonNullable<Parameters<typeof checkDatabaseHealth>[1]>['logger'];

    await checkDatabaseHealth(
      stubClient(() => Promise.reject(new Error('boom'))),
      { logger },
    );

    expect(error).toHaveBeenCalledTimes(1);
  });
});
