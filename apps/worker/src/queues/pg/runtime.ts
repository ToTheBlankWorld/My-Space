import { jobs as jobsStore, type DatabaseClient } from '@space/database';
import type { Logger } from '@space/logger';
import type { Prisma } from '@space/database';
import type { Clock } from '@space/time';

import type { PgQueueMetrics } from './metrics';

/**
 * The PostgreSQL queue runtime — the seam between "how a job is stored and
 * claimed" (the `jobs` repository) and "what the job does" (a handler).
 *
 * This is deliberately small. It is a poll loop with per-queue concurrency
 * lanes, a lease reaper, and the retry/dead-letter plumbing around a handler
 * call. Everything else — payloads, processors, domain logic — stays exactly
 * where it is. (It was built this way so the previous BullMQ processors could
 * migrate by moving their bodies into handlers without rewriting them.)
 *
 * Timing correctness lives in the database (lease expiry, schedule cadence,
 * backoff anchoring); this module's clocks only decide when to wake up and
 * poll. The loop is safe to run in several processes at once: claims are
 * `FOR UPDATE SKIP LOCKED`, so lanes never double-execute a job.
 */

/** Thrown by a handler to dead-letter immediately, skipping any retry budget. */
export class PermanentJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentJobError';
  }
}

/** What a processor receives: identity, payload, and retry state. */
export interface PgJobContext {
  jobId: string;
  queue: string;
  name: string;
  payload: Prisma.JsonValue;
  /** Claim attempts so far, including this one (1 on the first execution). */
  attempts: number;
  maxAttempts: number;
}

export type PgJobHandler = (context: PgJobContext) => Promise<unknown>;

/** One queue class: its name and how many jobs may run concurrently. */
export interface PgQueueClass {
  queue: string;
  concurrency: number;
}

/**
 * The repository surface the runtime needs. `Pick<…>` of the `jobs` module so
 * the contract can never drift from the real implementation, and tests can
 * substitute a recording fake.
 */
export type PgQueueJobStore = Pick<
  typeof jobsStore,
  | 'claimJobs'
  | 'renewJobLease'
  | 'completeJob'
  | 'failJob'
  | 'markJobDead'
  | 'reapExpiredJobs'
  | 'inspectQueueDepth'
  | 'oldestPendingJob'
  | 'scheduleLagSeconds'
>;

export interface PgQueueRuntimeOptions {
  db: DatabaseClient;
  logger: Logger;
  /** Identifies this process in `lockedBy`; any stable per-instance string. */
  workerId: string;
  classes: readonly PgQueueClass[];
  /** Handlers keyed by queue name; a handler may branch on the job's `name`. */
  handlers: Readonly<Record<string, PgJobHandler>>;
  metrics: PgQueueMetrics;
  /** Injected clock for bookkeeping timestamps (completion instants). */
  clock: Clock;
  store?: PgQueueJobStore;
  /** Job lease duration; processors heartbeat at a third of this. */
  leaseSeconds?: number;
  /** Heartbeat interval override (tests). Defaults to a third of the lease,
   * clamped to at least one second. */
  heartbeatMs?: number;
  pollIntervalMs?: number;
  reaperIntervalMs?: number;
  /** Ceiling for one backoff step on the failure path. */
  backoffCapMs?: number;
}

export interface PgQueueRuntime {
  /** Starts the poll and reaper loops. */
  start(): void;
  /** Stops the loops and waits for in-flight jobs to settle. */
  stop(): Promise<void>;
  /**
   * Runs one claim-and-drain cycle without timers: claims up to each class's
   * spare capacity, executes everything claimed, waits for it to finish, and
   * returns how many jobs were claimed. Used by tests and by a future manual
   * tick path.
   */
  runOnce(): Promise<number>;
}

const DEFAULT_LEASE_SECONDS = 90;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_REAPER_INTERVAL_MS = 15_000;

export const createPgQueueRuntime = (options: PgQueueRuntimeOptions): PgQueueRuntime => {
  const {
    db,
    logger,
    workerId,
    classes,
    handlers,
    metrics,
    clock,
    store = jobsStore,
    leaseSeconds = DEFAULT_LEASE_SECONDS,
    heartbeatMs: heartbeatMsOption,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    reaperIntervalMs = DEFAULT_REAPER_INTERVAL_MS,
    backoffCapMs,
  } = options;

  const runtimeLogger = logger.child({ component: 'pg-queue', workerId });
  // Heartbeat cadence: renew well before the lease can lapse, but never spin.
  const heartbeatMs = heartbeatMsOption ?? Math.max((leaseSeconds * 1000) / 3, 1_000);

  // Per-queue in-flight lanes. A job's promise removes itself when it settles.
  const inflight = new Map<string, Set<Promise<void>>>(
    classes.map(({ queue }) => [queue, new Set<Promise<void>>()]),
  );

  let pollTimer: NodeJS.Timeout | undefined;
  let reaperTimer: NodeJS.Timeout | undefined;

  const execute = (job: Prisma.BackgroundJobGetPayload<object>): void => {
    const lane = inflight.get(job.queue);
    if (lane === undefined) {
      return;
    }

    const run = async (): Promise<void> => {
      const jobLogger = runtimeLogger.child({
        jobId: job.id,
        queue: job.queue,
        name: job.name,
        attempts: job.attempts,
      });
      jobLogger.debug('pg job started');

      const heartbeat = setInterval(() => {
        void store
          .renewJobLease(db, job.id, workerId, leaseSeconds)
          .then((renewed) => {
            if (!renewed) {
              // The reaper took the row back; this attempt is a zombie. Stop
              // heartbeating and let the processor finish into the void — its
              // completion/failure writes will no-op on the CAS guards.
              clearInterval(heartbeat);
              jobLogger.warn('pg job lease was lost mid-run');
            }
          })
          .catch((error: unknown) => {
            jobLogger.warn({ err: error }, 'pg job lease renewal failed');
          });
      }, heartbeatMs);

      try {
        const handler = handlers[job.queue];
        if (handler === undefined) {
          throw new PermanentJobError(`no handler registered for queue ${job.queue}`);
        }

        await handler({
          jobId: job.id,
          queue: job.queue,
          name: job.name,
          payload: job.payload,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
        });

        const completed = await store.completeJob(db, job.id, clock.now());
        if (completed) {
          metrics.completed.inc({ queue: job.queue });
          jobLogger.info('pg job completed');
        } else {
          jobLogger.warn('pg job finished but no longer holds the lease');
        }
      } catch (error) {
        metrics.failed.inc({ queue: job.queue });
        if (error instanceof PermanentJobError) {
          await store.markJobDead(db, job.id, error);
          metrics.dead.inc({ queue: job.queue });
          jobLogger.error({ err: error }, 'pg job failed permanently');
          return;
        }

        const outcome = await store.failJob(db, job.id, error, { backoffCapMs });
        if (outcome === 'retry') {
          metrics.retried.inc({ queue: job.queue });
          jobLogger.warn({ err: error }, 'pg job failed; rescheduled with backoff');
        } else if (outcome === 'dead') {
          metrics.dead.inc({ queue: job.queue });
          jobLogger.error({ err: error }, 'pg job exhausted its retries');
        } else {
          jobLogger.error({ err: error, outcome }, 'pg job failure could not be recorded');
        }
      } finally {
        clearInterval(heartbeat);
      }
    };

    // The run body handles domain failures, but the bookkeeping writes
    // themselves can still throw on a database outage — swallow into the log
    // so this fire-and-forget lane can never surface an unhandled rejection.
    const promise = run()
      .catch((error: unknown) => {
        runtimeLogger.error({ err: error, jobId: job.id }, 'pg job bookkeeping failed');
      })
      .finally(() => {
        lane.delete(promise);
      });
    lane.add(promise);
  };

  /** One claim pass across every class with spare lane capacity. */
  const cycle = async (): Promise<number> => {
    let claimed = 0;
    for (const { queue, concurrency } of classes) {
      const lane = inflight.get(queue);
      if (lane === undefined) {
        continue;
      }
      const capacity = concurrency - lane.size;
      if (capacity <= 0) {
        continue;
      }
      try {
        const due = await store.claimJobs(db, { queue, workerId, leaseSeconds, limit: capacity });
        for (const job of due) {
          metrics.claimed.inc({ queue });
          execute(job);
          claimed += 1;
        }
      } catch (error) {
        // A failed poll is not fatal: the next tick retries. Log so a sustained
        // database outage is visible without crashing the worker.
        runtimeLogger.error({ err: error, queue }, 'pg queue poll failed');
      }
    }
    return claimed;
  };

  const drain = async (): Promise<void> => {
    const running = [...inflight.values()].flatMap((lane) => [...lane]);
    await Promise.allSettled(running);
  };

  /**
   * Recovery and gauges, on the reaper cadence. Every statement here is an
   * atomic CAS, so several workers running this concurrently stay consistent —
   * a row is transitioned exactly once no matter how many reapers race.
   */
  const maintain = async (): Promise<void> => {
    const { reaped, dead } = await store.reapExpiredJobs(db);
    if (reaped > 0 || dead > 0) {
      metrics.reaped.inc({}, reaped);
      if (dead > 0) {
        metrics.dead.inc({}, dead);
      }
      runtimeLogger.warn({ reaped, dead }, 'pg queue reaped expired leases');
    }

    for (const row of await store.inspectQueueDepth(db)) {
      if (row.status === 'PENDING') {
        metrics.depth.set(row.count, { queue: row.queue });
      }
    }

    const oldest = await store.oldestPendingJob(db);
    metrics.oldestPendingSeconds.set(
      oldest === null ? 0 : Math.max(0, (Date.now() - oldest.runAt.getTime()) / 1000),
    );
    metrics.scheduleLagSeconds.set(await store.scheduleLagSeconds(db));
  };

  return {
    start(): void {
      // Unref'd: the health server owns the process's lifetime. An idle runtime
      // must never keep a worker that is shutting down alive.
      pollTimer = setInterval(() => {
        void cycle();
      }, pollIntervalMs);
      pollTimer.unref();

      reaperTimer = setInterval(() => {
        void maintain().catch((error: unknown) => {
          runtimeLogger.error({ err: error }, 'pg queue maintenance failed');
        });
      }, reaperIntervalMs);
      reaperTimer.unref();

      runtimeLogger.info(
        {
          classes: classes.map(({ queue, concurrency }) => ({ queue, concurrency })),
          leaseSeconds,
          pollIntervalMs,
          reaperIntervalMs,
        },
        'pg queue runtime started',
      );
    },

    async stop(): Promise<void> {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      if (reaperTimer !== undefined) {
        clearInterval(reaperTimer);
        reaperTimer = undefined;
      }
      await drain();
      runtimeLogger.info('pg queue runtime stopped');
    },

    async runOnce(): Promise<number> {
      const claimed = await cycle();
      await drain();
      return claimed;
    },
  };
};
