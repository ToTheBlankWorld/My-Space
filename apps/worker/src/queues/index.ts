import type { Logger } from '@space/logger';
import type { Metrics } from '@space/metrics';
import { QUEUE_NAMES, QUEUE_PREFIX } from '@space/types';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import type { Worker } from 'bullmq';

export { QUEUE_NAMES, QUEUE_PREFIX } from '@space/types';

/**
 * Redis connection health check and lifecycle.
 *
 * The connection is shared across all queues and workers in the process. It
 * reports readiness through the health server probe chain and is released
 * during graceful shutdown.
 */
export interface RedisHealth {
  /** True when the Redis connection is alive. */
  readonly probe: () => Promise<{ name: string; ok: boolean }>;
}

export interface RedisConnectionOptions {
  redisUrl: string;
  logger: Logger;
}

export const createRedisConnection = (url: string): Redis => {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
};

/**
 * Creates a Redis health probe.
 *
 * Returns a `probe` function that pings Redis and reports health in the shape
 * the /readyz endpoint expects. Does not throw — a Redis outage is reported as
 * unhealthy, not fatal.
 */
export const createRedisHealth = (connection: Redis): RedisHealth => ({
  probe: async () => {
    try {
      const result = await connection.ping();
      return { name: 'redis', ok: result === 'PONG' };
    } catch {
      return { name: 'redis', ok: false };
    }
  },
});

// ---------------------------------------------------------------------------
// Queue definitions
// ---------------------------------------------------------------------------

export interface QueueDefinitions {
  calendarSync: Queue<CalendarSyncJobPayload>;
  calendarRefresh: Queue<CalendarRefreshJobPayload>;
  maintenance: Queue<MaintenanceJobPayload>;
  planning: Queue<PlanningJobPayload>;
  notifications: Queue<NotificationJobPayload>;
  autonomyReview: Queue<AutonomyReviewJobPayload>;
}

export interface CalendarSyncJobPayload {
  /** The user who owns the connection. */
  userId: string;
  /** The CalendarConnection row id. */
  connectionId: string;
  /** Optional: sync a specific calendar. If absent, sync all selected. */
  calendarId?: string;
  /** Whether this is a full re-sync (ignores sync token). */
  fullSync?: boolean;
}

export interface CalendarRefreshJobPayload {
  userId: string;
  connectionId: string;
}

export interface MaintenanceJobPayload {
  /** The maintenance task to run. */
  task: 'prune-retained-data';
}

/**
 * One planning pass: produce the day's plan for a user.
 *
 * `spaceId` and `planVersion` are the optimistic-concurrency guard. The worker
 * ships with the version it loaded; when it saves, a version that moved under it
 * (a foreground edit, another pass) aborts the write so a stale plan never
 * overwrites a newer one.
 */
export interface PlanningJobPayload {
  /** The user whose day is being planned. */
  userId: string;
  /** The calendar date of the plan. */
  date: string;
  /** The Space being planned. */
  spaceId: string;
  /** The plan version the job loaded and must write against. */
  planVersion: number;
  /** Who triggered the pass — 'user' from a button, 'autonomous' from the loop. */
  trigger?: 'user' | 'autonomous';
}

/**
 * One notification job: either a full sweep, or a single queued-email delivery.
 *
 * `sweep` is enqueued by the scheduler (a single repeatable job, `jobId`
 * `space:notification-sweep`) and fans out one `delivery` job per email it
 * prepares. Each delivery is idempotent by `emailLogId` through the
 * terminal-email guard in `deliverQueuedEmail`.
 */
export type NotificationJobPayload =
  { kind: 'sweep' } | { kind: 'delivery'; notificationId: string; emailLogId: string };

export type NotificationQueue = Queue<NotificationJobPayload>;

/**
 * One autonomy review pass: observe, detect, classify, then delegate replans.
 *
 * This is a single repeatable job (`jobId: space:autonomy-review`). The
 * service itself does not plan — it hands off to the planning queue.
 */
export type AutonomyReviewJobPayload = { kind: 'review' };

/**
 * Creates the BullMQ queues.
 *
 * Queues are named with a prefix for Redis namespace isolation and share the
 * single Redis connection (BullMQ multiplexes all queue traffic over one
 * connection, so per-queue connections would add nothing but sockets). Default
 * job options are set per queue; each worker declares its own concurrency and
 * limiter.
 *
 * Locking of an in-flight job is governed by the Worker's `lockDuration`; the
 * shared settings live in {@link WORKER_OPTIONS} so every worker extends the
 * same stall and lock-recovery policy.
 */
export const createQueues = (connection: Redis): QueueDefinitions => {
  const connectionOptions = { connection, prefix: QUEUE_PREFIX };

  return {
    calendarSync: new Queue<CalendarSyncJobPayload>(QUEUE_NAMES.calendarSync, {
      ...connectionOptions,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86400 },
      },
    }),
    calendarRefresh: new Queue<CalendarRefreshJobPayload>(QUEUE_NAMES.calendarRefresh, {
      ...connectionOptions,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86400 },
      },
    }),
    maintenance: new Queue<MaintenanceJobPayload>(QUEUE_NAMES.maintenance, {
      ...connectionOptions,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 },
      },
    }),
    planning: new Queue<PlanningJobPayload>(QUEUE_NAMES.planning, {
      ...connectionOptions,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 },
      },
    }),
    notifications: new Queue<NotificationJobPayload>(QUEUE_NAMES.notifications, {
      ...connectionOptions,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 },
      },
    }),
    autonomyReview: new Queue<AutonomyReviewJobPayload>(QUEUE_NAMES.autonomyReview, {
      ...connectionOptions,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 },
      },
    }),
  };
};

// ---------------------------------------------------------------------------
// Worker processors
// ---------------------------------------------------------------------------

/**
 * The lock and stall policy every queue worker opts into explicitly.
 *
 * `lockDuration` is how long a worker may hold a job before BullMQ considers
 * it stalled; the default 30s expires mid-job on the long-running passes
 * (calendar sync, autonomy review), which would re-queue work that was already
 * in flight. `maxStalledCount` allows one recovery from a genuine stall before
 * a job is retired to `failed` — most processors are idempotent or CAS-guarded,
 * so a single zombie pick-up is cheap and safe to recover from.
 */
export const WORKER_OPTIONS = {
  lockDuration: 60_000,
  maxStalledCount: 2,
} as const;

/**
 * Attaches a warn-level handler for every job that exhausts its retries.
 *
 * The processor already logs its own failures in context; this listener is the
 * safety net for the ones that bubble out (unexpected errors) or that fail
 * after the final attempt, so the queue state and the logs always agree.
 */
export const attachFailureLogging = (worker: Worker, logger: Logger): void => {
  worker.on('failed', (job, error) => {
    logger.warn(
      {
        jobId: job?.id,
        queue: job?.queueName ?? 'unknown',
        attemptsMade: job?.attemptsMade,
        err: error,
      },
      'worker job failed',
    );
  });
};

/**
 * Captures queue throughput and latency into the metrics registry.
 *
 * Counters track started/completed/failed per queue; the histogram records the
 * time from a job's processing start to its finish (completion or failure), so
 * both a slow queue and a regain of health are visible on `/metrics`.
 */
export const attachJobMetrics = (worker: Worker, metrics: Metrics, queueName: string): void => {
  const started = metrics.counter({
    name: 'worker_jobs_started_total',
    help: 'Jobs claimed and started by the worker',
  });
  const completed = metrics.counter({
    name: 'worker_jobs_completed_total',
    help: 'Jobs completed successfully by the worker',
  });
  const failed = metrics.counter({
    name: 'worker_jobs_failed_total',
    help: 'Jobs that exhausted their retries on the worker',
  });
  const duration = metrics.histogram(
    { name: 'worker_job_duration_seconds', help: 'Job processing duration in seconds' },
    [1, 5, 15, 30, 60],
  );

  const recordDuration = (job: { finishedOn?: number; processedOn?: number }): void => {
    const { finishedOn, processedOn } = job;
    if (finishedOn === undefined || processedOn === undefined) {
      return;
    }
    duration.observe((finishedOn - processedOn) / 1000, { queue: queueName });
  };

  worker.on('active', (job) => {
    started.inc({ queue: queueName, jobName: job.name });
  });
  worker.on('completed', (job) => {
    completed.inc({ queue: queueName });
    recordDuration(job);
  });
  worker.on('failed', (job) => {
    failed.inc({ queue: queueName });
    if (job !== undefined) {
      recordDuration(job);
    }
  });
};
