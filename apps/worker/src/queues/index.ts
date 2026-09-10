import type { Logger } from '@space/logger';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import type { Worker } from 'bullmq';

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
  task: 'cleanup-expired-sessions' | 'purge-deleted-events';
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
 * Queues are named with a prefix for Redis namespace isolation. Each queue has
 * its own connection to avoid head-of-line blocking across domains.
 */
export const createQueues = (connection: Redis): QueueDefinitions => {
  const connectionOptions = { connection };

  return {
    calendarSync: new Queue<CalendarSyncJobPayload>('space:calendar-sync', {
      ...connectionOptions,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86400 },
      },
    }),
    calendarRefresh: new Queue<CalendarRefreshJobPayload>('space:calendar-refresh', {
      ...connectionOptions,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86400 },
      },
    }),
    maintenance: new Queue<MaintenanceJobPayload>('space:maintenance', {
      ...connectionOptions,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 },
      },
    }),
    planning: new Queue<PlanningJobPayload>('space:planning', {
      ...connectionOptions,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 },
      },
    }),
    notifications: new Queue<NotificationJobPayload>('space:notifications', {
      ...connectionOptions,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 },
      },
    }),
    autonomyReview: new Queue<AutonomyReviewJobPayload>('space:autonomy-review', {
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

export interface WorkerProcessors {
  calendarSyncWorker: Worker;
  maintenanceWorker: Worker;
}
