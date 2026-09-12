import type { Database } from '@space/database';
import type { Logger } from '@space/logger';
import { autoSyncJobId } from '@space/types';

import type { QueueDefinitions } from './queues';

/**
 * Auto-sync scheduling.
 *
 * Self-healing: every CONNECTED connection is registered as a repeatable BullMQ
 * job at worker boot. The job is de-duplicated by its deterministic `jobId`, so
 * a rolling deploy that launches several workers only ever creates one schedule
 * per connection, and a connection that has no registration (a new worker was
 * released before the feature shipped) is picked up automatically.
 *
 * New connections are scheduled by the web API when they connect; the worker
 * re-registering them daily-implicit is a safety net, not the primary path.
 */

export interface ScheduleAutoSyncsInput {
  db: Database;
  queues: QueueDefinitions;
  intervalMinutes: number;
  logger: Logger;
}

export const scheduleAutoSyncs = async ({
  db,
  queues,
  intervalMinutes,
  logger,
}: ScheduleAutoSyncsInput): Promise<void> => {
  const connections = await db.calendarConnection.findMany({
    where: { status: 'CONNECTED' },
    select: { id: true, userId: true },
  });

  for (const connection of connections) {
    await queues.calendarSync.add(
      'auto-sync',
      {
        userId: connection.userId,
        connectionId: connection.id,
        fullSync: false,
      },
      {
        repeat: {
          every: intervalMinutes * 60_000,
        },
        jobId: autoSyncJobId(connection.id),
      },
    );
  }

  logger.info(
    { connections: connections.length, intervalMinutes },
    'auto-sync scheduled for connected calendar connections',
  );
};

/**
 * Registers the single repeatable notification sweep job.
 *
 * The sweep is a lone BullMQ repeatable job (`jobId: space:notification-sweep`).
 * De-duplication by `jobId` means a fleet of workers only ever holds one
 * schedule, and the sweep itself fans out per-email delivery jobs.
 */
export interface ScheduleNotificationSweepInput {
  queues: QueueDefinitions;
  intervalMinutes: number;
  logger: Logger;
}

export const scheduleNotificationSweep = async ({
  queues,
  intervalMinutes,
  logger,
}: ScheduleNotificationSweepInput): Promise<void> => {
  await queues.notifications.add(
    'sweep',
    { kind: 'sweep' },
    {
      repeat: { every: intervalMinutes * 60_000 },
      jobId: 'space:notification-sweep',
    },
  );

  logger.info({ intervalMinutes }, 'notification sweep scheduled');
};

/**
 * Registers the single repeatable autonomy review job.
 *
 * One schedule per fleet (`jobId: space:autonomy-review`). The review walks
 * the OBSERVE → DETECT → CLASSIFY → PLAN(scheduled) → AUDIT → NOTIFY loop
 * on a fixed interval.
 */
export interface ScheduleAutonomyReviewInput {
  queues: QueueDefinitions;
  intervalMinutes: number;
  logger: Logger;
}

export const scheduleAutonomyReview = async ({
  queues,
  intervalMinutes,
  logger,
}: ScheduleAutonomyReviewInput): Promise<void> => {
  await queues.autonomyReview.add(
    'review',
    { kind: 'review' },
    {
      repeat: { every: intervalMinutes * 60_000 },
      jobId: 'space:autonomy-review',
    },
  );

  logger.info({ intervalMinutes }, 'autonomy review scheduled');
};

/**
 * Registers the single repeatable maintenance job.
 *
 * De-duplicated by `jobId: space:maintenance` so a fleet of workers only ever
 * holds one schedule. The worker itself runs with `concurrency: 1`, so prunes
 * never contend with themselves across processes.
 */
export interface ScheduleMaintenanceInput {
  queues: QueueDefinitions;
  intervalMinutes: number;
  logger: Logger;
}

export const scheduleMaintenance = async ({
  queues,
  intervalMinutes,
  logger,
}: ScheduleMaintenanceInput): Promise<void> => {
  await queues.maintenance.add(
    'prune-retained-data',
    { task: 'prune-retained-data' },
    {
      repeat: { every: intervalMinutes * 60_000 },
      jobId: 'space:maintenance',
    },
  );

  logger.info({ intervalMinutes }, 'maintenance schedule registered');
};
