import type { Database, Prisma } from '@space/database';
import { jobs as jobsStore } from '@space/database';
import type { Logger } from '@space/logger';
import { autoSyncScheduleKey, QUEUE_NAMES } from '@space/types';
import type { Clock } from '@space/time';

import { QUEUE_JOB_DEFAULTS } from './handlers';

/**
 * PostgreSQL schedule registration and the due-schedule ticker.
 *
 * Repeatable work lives in `job_schedules`: one row per schedule under a
 * stable key, re-registered (re-anchored) at every worker boot — idempotent
 * "replaces rather than stacks" semantics, so a rolling deploy never stacks
 * schedules. Auto-sync schedules for connections that are no longer CONNECTED
 * are deleted instead of firing into the void.
 *
 * The ticker claims due schedules with `FOR UPDATE SKIP LOCKED` (fleet-safe
 * by construction) and materialises one job per claimed schedule. It is a
 * poll loop on a plain interval — acceptable for periodic scheduling; no
 * correctness-critical timing depends on the Node process clock.
 */

export const PG_SCHEDULE_KEYS = {
  notificationSweep: 'space:notification-sweep',
  autonomyReview: 'space:autonomy-review',
  maintenance: 'space:maintenance',
  /** Shared with the web producer via `@space/types` — one canonical identity
   * for automatic synchronization, upserted by the web and ticked here. */
  autoSync: autoSyncScheduleKey,
} as const;

/** Reads the auto-sync target connection out of a schedule's JSON payload. */
const schedulePayloadConnectionId = (payload: Prisma.JsonValue): string | null => {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const connectionId = (payload as Record<string, unknown>).connectionId;
  return typeof connectionId === 'string' && connectionId.length > 0 ? connectionId : null;
};

export interface PgScheduleRegistrationInput {
  db: Database;
  clock: Clock;
  logger: Logger;
  intervals: {
    calendarSyncMinutes: number;
    notificationSweepMinutes: number;
    autonomyReviewMinutes: number;
    maintenanceMinutes: number;
  };
  /** Auto-sync schedules are only registered when the sync pipeline is fully
   * configured (Google OAuth + keyring). */
  calendarConfigured: boolean;
}

/**
 * Registers (upserts) every repeatable schedule. Idempotent: booting several
 * workers re-anchors the same rows instead of stacking schedules.
 */
export const registerPgSchedules = async ({
  db,
  clock,
  logger,
  intervals,
  calendarConfigured,
}: PgScheduleRegistrationInput): Promise<void> => {
  const now = clock.now();

  await jobsStore.upsertJobSchedule(db, {
    scheduleKey: PG_SCHEDULE_KEYS.notificationSweep,
    queue: QUEUE_NAMES.notifications,
    name: 'sweep',
    payload: { kind: 'sweep' },
    everySeconds: intervals.notificationSweepMinutes * 60,
    nextRunAt: now,
  });

  await jobsStore.upsertJobSchedule(db, {
    scheduleKey: PG_SCHEDULE_KEYS.autonomyReview,
    queue: QUEUE_NAMES.autonomyReview,
    name: 'review',
    payload: { kind: 'review' },
    everySeconds: intervals.autonomyReviewMinutes * 60,
    nextRunAt: now,
  });

  await jobsStore.upsertJobSchedule(db, {
    scheduleKey: PG_SCHEDULE_KEYS.maintenance,
    queue: QUEUE_NAMES.maintenance,
    name: 'prune-retained-data',
    payload: { task: 'prune-retained-data' },
    everySeconds: intervals.maintenanceMinutes * 60,
    nextRunAt: now,
  });

  if (calendarConfigured) {
    const connections = await db.calendarConnection.findMany({
      where: { status: 'CONNECTED' },
      select: { id: true, userId: true },
    });

    for (const connection of connections) {
      await jobsStore.upsertJobSchedule(db, {
        scheduleKey: PG_SCHEDULE_KEYS.autoSync(connection.id),
        queue: QUEUE_NAMES.calendarSync,
        name: 'auto-sync',
        payload: { userId: connection.userId, connectionId: connection.id, fullSync: false },
        everySeconds: intervals.calendarSyncMinutes * 60,
        nextRunAt: now,
      });
    }

    // Self-healing removal: an auto-sync schedule whose connection is no
    // longer CONNECTED is deleted, so the schedule set converges on reality.
    const connectedIds = new Set(connections.map((connection) => connection.id));
    const schedules = await jobsStore.listJobSchedules(db);
    for (const schedule of schedules) {
      if (schedule.queue !== QUEUE_NAMES.calendarSync || schedule.name !== 'auto-sync') {
        continue;
      }
      const payloadConnectionId = schedulePayloadConnectionId(schedule.payload);
      if (payloadConnectionId !== null && !connectedIds.has(payloadConnectionId)) {
        await jobsStore.deleteJobSchedule(db, schedule.scheduleKey);
      }
    }

    logger.info(
      { connections: connections.length, intervalMinutes: intervals.calendarSyncMinutes },
      'pg auto-sync schedules registered for connected calendar connections',
    );
  }

  logger.info(
    {
      sweepMinutes: intervals.notificationSweepMinutes,
      reviewMinutes: intervals.autonomyReviewMinutes,
      maintenanceMinutes: intervals.maintenanceMinutes,
    },
    'pg repeatable schedules registered',
  );
};

export interface PgScheduleTicker {
  start(): void;
  stop(): Promise<void>;
  /** One claim-and-enqueue pass; returns how many schedules fired. */
  tick(): Promise<number>;
}

export interface PgScheduleTickerOptions {
  db: Database;
  clock: Clock;
  logger: Logger;
  /** How often to look for due schedules. */
  intervalMs?: number;
  /** Upper bound on schedules materialised per tick. */
  batchSize?: number;
}

export const createPgScheduleTicker = ({
  db,
  clock,
  logger,
  intervalMs = 5_000,
  batchSize = 50,
}: PgScheduleTickerOptions): PgScheduleTicker => {
  const tickerLogger = logger.child({ component: 'pg-schedule-ticker' });
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<number> => {
    const due = await jobsStore.claimDueSchedules(db, { limit: batchSize });
    for (const schedule of due) {
      const defaults = QUEUE_JOB_DEFAULTS[schedule.queue] ?? {
        maxAttempts: 3,
        backoffBaseMs: 10_000,
      };
      await jobsStore.enqueueJob(db, {
        queue: schedule.queue,
        name: schedule.name,
        payload: schedule.payload as Prisma.InputJsonValue,
        runAt: clock.now(),
        maxAttempts: defaults.maxAttempts,
        backoffBaseMs: defaults.backoffBaseMs,
      });
    }
    if (due.length > 0) {
      tickerLogger.info({ fired: due.length }, 'pg schedules ticked');
    }
    return due.length;
  };

  return {
    start(): void {
      timer = setInterval(() => {
        void tick().catch((error: unknown) => {
          // A failed tick is not fatal: the next interval retries, and the
          // schedule's nextRunAt only advances on a successful claim.
          tickerLogger.error({ err: error }, 'pg schedule tick failed');
        });
      }, intervalMs);
      timer.unref();
      tickerLogger.info({ intervalMs }, 'pg schedule ticker started');
    },

    stop(): Promise<void> {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      tickerLogger.info('pg schedule ticker stopped');
      return Promise.resolve();
    },

    tick,
  };
};
