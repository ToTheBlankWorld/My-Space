import { retention, type Database } from '@space/database';
import type { Gauge } from '@space/metrics';
import type { Logger } from '@space/logger';
import type { Clock } from '@space/time';

/**
 * The maintenance processor — the body of the PostgreSQL maintenance handler.
 *
 * Handles periodic housekeeping: data-retention prunes for the audit and
 * history tables, expired sessions and verifications, and calendar-event
 * tombstones. It additionally prunes terminal `BackgroundJob` rows (see
 * `pruneTerminalJobs` in the jobs repository), so the durable queue cannot
 * grow forever.
 */

export interface MaintenanceJobPayload {
  /** The maintenance task to run. */
  task: 'prune-retained-data';
}

export interface MaintenanceRetentionConfig {
  eventLogDays: number;
  agentActionDays: number;
  notificationDays: number;
  emailLogDays: number;
  sessionDays: number;
  verificationDays: number;
  calendarEventTombstoneDays: number;
}

export interface MaintenanceJobDeps {
  db: Database;
  clock: Clock;
  logger: Logger;
  retention: MaintenanceRetentionConfig;
  /** Optional: reports the last retention pass's pruned-row counts. Created
   * once per process by the bootstrap and shared by both queue runtimes. */
  prunedRows?: Gauge;
}

export const processMaintenanceJob = async (
  { db, clock, logger, retention: config, prunedRows }: MaintenanceJobDeps,
  payload: MaintenanceJobPayload,
): Promise<{ success: true; counts: retention.RetentionCounts }> => {
  const taskLogger = logger.child({ task: payload.task });
  taskLogger.info('maintenance job started');

  const counts = await retention.runRetention(db, {
    eventLogsOlderThan: retention.olderThanDays(clock.now(), config.eventLogDays),
    agentActionsOlderThan: retention.olderThanDays(clock.now(), config.agentActionDays),
    notificationsOlderThan: retention.olderThanDays(clock.now(), config.notificationDays),
    emailLogsOlderThan: retention.olderThanDays(clock.now(), config.emailLogDays),
    expiredSessionsOlderThan: retention.olderThanDays(clock.now(), config.sessionDays),
    expiredVerificationsOlderThan: retention.olderThanDays(clock.now(), config.verificationDays),
    calendarEventTombstonesOlderThan: retention.olderThanDays(
      clock.now(),
      config.calendarEventTombstoneDays,
    ),
  });

  if (prunedRows !== undefined) {
    prunedRows.set(counts.eventLogs.deleted, { table: 'event_logs' });
    prunedRows.set(counts.agentActions.deleted, { table: 'agent_actions' });
    prunedRows.set(counts.notifications.deleted, { table: 'notifications' });
    prunedRows.set(counts.emailLogs.deleted, { table: 'email_logs' });
    prunedRows.set(counts.sessions.deleted, { table: 'sessions' });
    prunedRows.set(counts.verifications.deleted, { table: 'verifications' });
    prunedRows.set(counts.calendarEventTombstones.deleted, { table: 'calendar_events' });
  }

  taskLogger.info({ counts, retentionDays: config }, 'retention prune completed');
  return { success: true, counts };
};
