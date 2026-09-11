import { retention, type Database } from '@space/database';
import type { Logger } from '@space/logger';
import type { Metrics } from '@space/metrics';
import type { Clock } from '@space/time';
import { QUEUE_NAMES, QUEUE_PREFIX } from '@space/types';
import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import type { MaintenanceJobPayload } from '.';
import { attachFailureLogging, WORKER_OPTIONS } from '.';

/**
 * Maintenance worker processor.
 *
 * Handles periodic housekeeping: data-retention prunes for the audit and history
 * tables, expired sessions and verifications, and calendar-event tombstones. It
 * is scheduled as a single repeatable BullMQ job (`jobId: space:maintenance`)
 * and must never run concurrently with itself, hence `concurrency: 1`.
 */
export interface MaintenanceRetentionConfig {
  eventLogDays: number;
  agentActionDays: number;
  notificationDays: number;
  emailLogDays: number;
  sessionDays: number;
  verificationDays: number;
  calendarEventTombstoneDays: number;
}

export interface MaintenanceWorkerDeps {
  logger: Logger;
  connection: Redis;
  db: Database;
  clock: Clock;
  retention: MaintenanceRetentionConfig;
  /** Optional: reports the last retention pass's pruned-row counts. */
  metrics?: Metrics;
}

export const createMaintenanceWorker = ({
  logger,
  connection,
  db,
  clock,
  retention: config,
  metrics,
}: MaintenanceWorkerDeps): Worker => {
  const prunedRows = metrics?.gauge({
    name: 'space_retention_pruned_rows',
    help: 'Rows pruned by the latest maintenance pass',
  });

  const recordPrune = (counts: retention.RetentionCounts): void => {
    if (prunedRows === undefined) {
      return;
    }
    prunedRows.set(counts.eventLogs.deleted, { table: 'event_logs' });
    prunedRows.set(counts.agentActions.deleted, { table: 'agent_actions' });
    prunedRows.set(counts.notifications.deleted, { table: 'notifications' });
    prunedRows.set(counts.emailLogs.deleted, { table: 'email_logs' });
    prunedRows.set(counts.sessions.deleted, { table: 'sessions' });
    prunedRows.set(counts.verifications.deleted, { table: 'verifications' });
    prunedRows.set(counts.calendarEventTombstones.deleted, { table: 'calendar_events' });
  };

  const worker = new Worker<MaintenanceJobPayload>(
    QUEUE_NAMES.maintenance,
    async (job: Job<MaintenanceJobPayload>) => {
      const taskLogger = logger.child({ jobId: job.id, task: job.data.task });

      taskLogger.info('maintenance job started');

      switch (job.data.task) {
        case 'prune-retained-data': {
          const now = clock.now();
          const counts = await retention.runRetention(db, {
            eventLogsOlderThan: retention.olderThanDays(now, config.eventLogDays),
            agentActionsOlderThan: retention.olderThanDays(now, config.agentActionDays),
            notificationsOlderThan: retention.olderThanDays(now, config.notificationDays),
            emailLogsOlderThan: retention.olderThanDays(now, config.emailLogDays),
            expiredSessionsOlderThan: retention.olderThanDays(now, config.sessionDays),
            expiredVerificationsOlderThan: retention.olderThanDays(now, config.verificationDays),
            calendarEventTombstonesOlderThan: retention.olderThanDays(
              now,
              config.calendarEventTombstoneDays,
            ),
          });

          recordPrune(counts);

          taskLogger.info({ counts, retentionDays: config }, 'retention prune completed');
          return { success: true, counts };
        }
      }
    },
    {
      connection,
      prefix: QUEUE_PREFIX,
      concurrency: 1,
      lockDuration: WORKER_OPTIONS.lockDuration,
      maxStalledCount: WORKER_OPTIONS.maxStalledCount,
    },
  );

  attachFailureLogging(worker, logger);
  return worker;
};
