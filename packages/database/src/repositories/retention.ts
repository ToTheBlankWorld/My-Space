import type { Database } from '../client';

/**
 * Data retention.
 *
 * The audit and history tables (event log, agent decisions, notifications,
 * email logs) are written far more often than they are read. They grow forever
 * unless something ages them out; the maintenance worker calls these prunes on
 * a schedule. Two rules keep them safe:
 *
 *  - Nothing is deleted while it might still be needed. The event log is only
 *    pruned **below the minimum sequence every outbox consumer has committed**,
 *    so a lagging consumer can still replay. Notifications and email logs are
 *    only pruned when their delivery attempt has reached a terminal state —
 *    in-flight rows are never touched. Calendar-event tombstones are only pruned
 *    when no `SpaceItem` references them (deleting a referenced row would cascade
 *    the item out of a user's plan).
 *
 *  - Age is always an upper bound, never a lower one. A row younger than the
 *    cut-off is never deleted, no matter how many prunes run.
 *
 * Every prune is a single bounded `deleteMany` and can be re-run freely: a rerun
 * deletes rows that arrived since the last pass and nothing else.
 */

/** A minutes-in-day helper: the cutoff instant `days` days before `now`. */
export const olderThanDays = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

/**
 * The smallest outbox cursor any consumer has committed, or null when no
 * consumer has ever run. Pruning below it would break replay for a consumer
 * that is still catching up, so a null here means "prune nothing from the log".
 */
export const getMinimumConsumedSequence = async (db: Database): Promise<bigint | null> => {
  const result = await db.outboxCursor.aggregate({ _min: { lastSequence: true } });
  return result._min.lastSequence;
};

export interface PruneResult {
  deleted: number;
  /** True when the prune was skipped by design (no safe boundary found). */
  skipped: boolean;
}

/**
 * Prunes event-log rows that are older than `cutoff` **and** already consumed
 * by every outbox consumer. When no consumer has ever committed, nothing is
 * deleted: a fresh consumer must always be able to replay the log from 0.
 */
export const pruneEventLogs = async (db: Database, cutoff: Date): Promise<PruneResult> => {
  const minimumConsumed = await getMinimumConsumedSequence(db);
  if (minimumConsumed === null) {
    return { deleted: 0, skipped: true };
  }

  const result = await db.eventLog.deleteMany({
    where: {
      occurredAt: { lt: cutoff },
      sequence: { lte: minimumConsumed },
    },
  });

  return { deleted: result.count, skipped: false };
};

/** Prunes agent decisions (the deterministic engine's audit trail) by age. */
export const pruneAgentActions = async (db: Database, cutoff: Date): Promise<PruneResult> => {
  const result = await db.agentAction.deleteMany({ where: { occurredAt: { lt: cutoff } } });
  return { deleted: result.count, skipped: false };
};

/** Delivery states that will never change again; safe to age out. */
const TERMINAL_DELIVERY_STATES = ['SENT', 'FAILED', 'SKIPPED'] as const;

/**
 * Prunes notifications whose delivery attempt has reached a terminal state and
 * that are older than `cutoff`. PENDING/QUEUED rows are always kept: they may
 * still be dispatched.
 */
export const pruneNotifications = async (db: Database, cutoff: Date): Promise<PruneResult> => {
  const result = await db.notification.deleteMany({
    where: {
      createdAt: { lt: cutoff },
      deliveryState: { in: [...TERMINAL_DELIVERY_STATES] },
    },
  });
  return { deleted: result.count, skipped: false };
};

/** Email statuses that will never change again; safe to age out. */
const TERMINAL_EMAIL_STATUSES = ['SENT', 'DELIVERED', 'BOUNCED', 'FAILED'] as const;

/**
 * Prunes email logs by age, keeping QUEUED rows (an in-flight delivery attempt
 * may still reference them for its idempotency guard).
 */
export const pruneEmailLogs = async (db: Database, cutoff: Date): Promise<PruneResult> => {
  const result = await db.emailLog.deleteMany({
    where: {
      createdAt: { lt: cutoff },
      status: { in: [...TERMINAL_EMAIL_STATUSES] },
    },
  });
  return { deleted: result.count, skipped: false };
};

/** Prunes sessions that have expired. `expiresAt` is already indexed. */
export const pruneExpiredSessions = async (db: Database, cutoff: Date): Promise<PruneResult> => {
  const result = await db.session.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return { deleted: result.count, skipped: false };
};

/** Prunes expired one-time verification values (OAuth state, etc.). */
export const pruneExpiredVerifications = async (
  db: Database,
  cutoff: Date,
): Promise<PruneResult> => {
  const result = await db.verification.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return { deleted: result.count, skipped: false };
};

/**
 * Prunes calendar-event tombstones that are older than `cutoff` and no longer
 * referenced by any `SpaceItem`. Referenced tombstones are kept on purpose:
 * the plan that cited them must still be able to explain itself.
 */
export const pruneCalendarEventTombstones = async (
  db: Database,
  cutoff: Date,
): Promise<PruneResult> => {
  const result = await db.calendarEvent.deleteMany({
    where: { deletedAt: { lt: cutoff }, spaceItem: { is: null } },
  });
  return { deleted: result.count, skipped: false };
};

/** The cut-off per store for one maintenance pass, oldest-kept by table. */
export interface RetentionWindow {
  eventLogsOlderThan: Date;
  agentActionsOlderThan: Date;
  notificationsOlderThan: Date;
  emailLogsOlderThan: Date;
  expiredSessionsOlderThan: Date;
  expiredVerificationsOlderThan: Date;
  calendarEventTombstonesOlderThan: Date;
}

export interface RetentionCounts {
  eventLogs: PruneResult;
  agentActions: PruneResult;
  notifications: PruneResult;
  emailLogs: PruneResult;
  sessions: PruneResult;
  verifications: PruneResult;
  calendarEventTombstones: PruneResult;
}

/**
 * Runs a full retention pass: every prune in one call, so the maintenance
 * worker logs one summary per job. The prunes are intentionally not wrapped in
 * a single transaction — each is atomic on its own, and a failure part-way
 * through a pass must not roll back the work that already succeeded.
 */
export const runRetention = async (
  db: Database,
  window: RetentionWindow,
): Promise<RetentionCounts> => {
  const [
    eventLogs,
    agentActions,
    notifications,
    emailLogs,
    sessions,
    verifications,
    calendarEventTombstones,
  ] = await Promise.all([
    pruneEventLogs(db, window.eventLogsOlderThan),
    pruneAgentActions(db, window.agentActionsOlderThan),
    pruneNotifications(db, window.notificationsOlderThan),
    pruneEmailLogs(db, window.emailLogsOlderThan),
    pruneExpiredSessions(db, window.expiredSessionsOlderThan),
    pruneExpiredVerifications(db, window.expiredVerificationsOlderThan),
    pruneCalendarEventTombstones(db, window.calendarEventTombstonesOlderThan),
  ]);

  return {
    eventLogs,
    agentActions,
    notifications,
    emailLogs,
    sessions,
    verifications,
    calendarEventTombstones,
  };
};
