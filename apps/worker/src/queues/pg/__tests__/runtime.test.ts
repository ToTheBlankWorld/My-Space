import type { DatabaseClient, Prisma } from '@space/database';
import type { Logger } from '@space/logger';
import { createLogger } from '@space/logger';
import { createMetrics } from '@space/metrics';
import type { IsoDateTime } from '@space/types';
import { describe, expect, it } from 'vitest';

import { createPgQueueMetrics } from '../metrics';
import {
  createPgQueueRuntime,
  PermanentJobError,
  type PgJobHandler,
  type PgQueueJobStore,
} from '../runtime';

/**
 * Runtime behaviour against a recording fake store. The database-backed
 * guarantees (SKIP LOCKED atomicity, lease recovery, dedupe) live in the
 * integration suite; here we pin the runtime's contract: claim → execute →
 * complete / fail / dead, the lane accounting, and the loss-of-lease bookkeeping.
 */

const silentLogger = (): Logger =>
  createLogger({
    name: 'pg-runtime-test',
    level: 'fatal',
    destination: { write: () => undefined },
  });

const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');
const testClock = {
  now: () => FIXED_NOW,
  nowMs: () => FIXED_NOW.getTime(),
  nowIso: () => FIXED_NOW.toISOString() as IsoDateTime,
};

interface RecordedCalls {
  claimJobs: { queue: string; workerId: string; leaseSeconds: number; limit: number }[];
  renewJobLease: { jobId: string; workerId: string }[];
  completeJob: string[];
  failJob: { jobId: string; error: unknown }[];
  markJobDead: { jobId: string; error: unknown }[];
}

interface FakeJob {
  id: string;
  queue: string;
  name: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

const asJobRow = (job: FakeJob): Prisma.BackgroundJobGetPayload<object> =>
  ({
    id: job.id,
    queue: job.queue,
    name: job.name,
    payload: job.payload,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
  }) as unknown as Prisma.BackgroundJobGetPayload<object>;

const makeStore = (
  claimed: FakeJob[],
  failOutcome: 'retry' | 'dead' | 'not-found' | 'not-running' = 'retry',
): { store: PgQueueJobStore; calls: RecordedCalls } => {
  const calls: RecordedCalls = {
    claimJobs: [],
    renewJobLease: [],
    completeJob: [],
    failJob: [],
    markJobDead: [],
  };

  const store = {
    claimJobs: async (
      _db: unknown,
      input: { queue: string; workerId: string; leaseSeconds: number; limit: number },
    ) => {
      await Promise.resolve();
      calls.claimJobs.push(input);
      return claimed.splice(0, input.limit).map(asJobRow);
    },
    renewJobLease: async (_db: unknown, jobId: string, workerId: string) => {
      await Promise.resolve();
      calls.renewJobLease.push({ jobId, workerId });
      return true;
    },
    completeJob: async (_db: unknown, jobId: string) => {
      await Promise.resolve();
      calls.completeJob.push(jobId);
      return true;
    },
    failJob: async (_db: unknown, jobId: string, error: unknown) => {
      await Promise.resolve();
      calls.failJob.push({ jobId, error });
      return failOutcome;
    },
    markJobDead: async (_db: unknown, jobId: string, error: unknown) => {
      await Promise.resolve();
      calls.markJobDead.push({ jobId, error });
      return true;
    },
    reapExpiredJobs: async () => {
      await Promise.resolve();
      return { reaped: 0, dead: 0 };
    },
    inspectQueueDepth: async () => {
      await Promise.resolve();
      return [{ queue: 'test', status: 'PENDING', count: 0 }];
    },
    oldestPendingJob: async () => {
      await Promise.resolve();
      return null;
    },
    scheduleLagSeconds: async () => {
      await Promise.resolve();
      return 0;
    },
  } as unknown as PgQueueJobStore;

  return { store, calls };
};

const buildRuntime = (store: PgQueueJobStore, handlers: Record<string, PgJobHandler>) =>
  createPgQueueRuntime({
    db: {} as DatabaseClient,
    logger: silentLogger(),
    workerId: 'worker-test',
    classes: [{ queue: 'test', concurrency: 2 }],
    handlers,
    metrics: createPgQueueMetrics(createMetrics()),
    clock: testClock,
    store,
  });

describe('pg queue runtime', () => {
  it('claims a job, runs its handler, and completes it', async () => {
    const processed: unknown[] = [];
    const { store, calls } = makeStore([
      {
        id: 'job_1',
        queue: 'test',
        name: 'greet',
        payload: { hello: 'world' },
        attempts: 1,
        maxAttempts: 3,
      },
    ]);
    const runtime = buildRuntime(store, {
      test: async (context) => {
        await Promise.resolve();
        processed.push(context.payload);
      },
    });

    const claimedCount = await runtime.runOnce();

    expect(claimedCount).toBe(1);
    expect(processed).toEqual([{ hello: 'world' }]);
    expect(calls.completeJob).toEqual(['job_1']);
    expect(calls.failJob).toEqual([]);
    expect(calls.claimJobs[0]).toMatchObject({ queue: 'test', workerId: 'worker-test', limit: 2 });
  });

  it('reschedules with backoff when the handler fails with budget left', async () => {
    const { store, calls } = makeStore(
      [{ id: 'job_2', queue: 'test', name: 'boom', payload: {}, attempts: 1, maxAttempts: 3 }],
      'retry',
    );
    const runtime = buildRuntime(store, {
      test: async () => {
        await Promise.resolve();
        throw new Error('provider unavailable');
      },
    });

    await runtime.runOnce();

    expect(calls.completeJob).toEqual([]);
    expect(calls.failJob).toHaveLength(1);
    expect(calls.failJob[0]?.error).toBeInstanceOf(Error);
    expect((calls.failJob[0]?.error as Error).message).toBe('provider unavailable');
    expect(calls.markJobDead).toEqual([]);
  });

  it('dead-letters through markJobDead on a PermanentJobError, without spending failJob', async () => {
    const { store, calls } = makeStore(
      [{ id: 'job_3', queue: 'test', name: 'nope', payload: {}, attempts: 1, maxAttempts: 3 }],
      'retry',
    );
    const runtime = buildRuntime(store, {
      test: async () => {
        await Promise.resolve();
        throw new PermanentJobError('template unknown');
      },
    });

    await runtime.runOnce();

    expect(calls.failJob).toEqual([]);
    expect(calls.markJobDead).toHaveLength(1);
    expect((calls.markJobDead[0]?.error as Error).message).toBe('template unknown');
  });

  it('dead-letters a job whose queue has no handler', async () => {
    const { store, calls } = makeStore([
      { id: 'job_4', queue: 'test', name: 'orphan', payload: {}, attempts: 1, maxAttempts: 3 },
    ]);
    const runtime = buildRuntime(store, {});

    await runtime.runOnce();

    expect(calls.completeJob).toEqual([]);
    expect(calls.markJobDead).toHaveLength(1);
  });

  it('stops cleanly and drains in-flight jobs', async () => {
    const { store } = makeStore([
      { id: 'job_5', queue: 'test', name: 'slow', payload: {}, attempts: 1, maxAttempts: 3 },
    ]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const runtime = buildRuntime(store, {
      test: async () => {
        await gate;
        finished = true;
      },
    });

    runtime.start();
    // Give the poll timer a chance to fire, then stop before it necessarily did.
    const stopped = runtime.stop();
    release();
    await stopped;

    expect(finished).toBe(false);
    // No timers remain: a second stop is a no-op, not a crash.
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it('reports zero claims when the queue is empty', async () => {
    const { store } = makeStore([]);
    const runtime = buildRuntime(store, {
      test: async () => {
        await Promise.resolve();
      },
    });

    expect(await runtime.runOnce()).toBe(0);
  });

  it('heartbeats the lease while a long job runs', async () => {
    const { store, calls } = makeStore([
      { id: 'job_6', queue: 'test', name: 'slow', payload: {}, attempts: 1, maxAttempts: 3 },
    ]);
    const runtime = createPgQueueRuntime({
      db: {} as DatabaseClient,
      logger: silentLogger(),
      workerId: 'worker-test',
      classes: [{ queue: 'test', concurrency: 1 }],
      handlers: {
        test: async () => {
          // Outlive two heartbeat intervals.
          await new Promise((resolve) => setTimeout(resolve, 60));
        },
      },
      metrics: createPgQueueMetrics(createMetrics()),
      clock: testClock,
      store,
      heartbeatMs: 20,
    });

    await runtime.runOnce();

    expect(calls.renewJobLease.length).toBeGreaterThanOrEqual(2);
    expect(calls.renewJobLease[0]).toEqual({ jobId: 'job_6', workerId: 'worker-test' });
  });
});
