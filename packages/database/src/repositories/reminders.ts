import { withDomainErrors } from '../errors';
import type { Database } from '../client';

/**
 * Reminder lifecycle for the dispatcher.
 *
 * A reminder is domain intent ("nudge me about X at this time") with no delivery
 * details — delivery is the notification pipeline's job. The dispatcher reads
 * due reminders, claims them with a compare-and-swap, hands the intent to a
 * notification, and only then flips the reminder's own state. `PENDING` is the
 * only claimable state, so two workers can never dispatch the same reminder.
 */

/**
 * Reminders that are due to fire, oldest due first. Bounded batch.
 *
 * Only `PENDING`/`PENDING` rows are eligible: a completed, cancelled or already
 * claimed reminder (QUEUED/SENT) is never redispatched. The query rides the
 * `[deliveryState, remindAt]` index.
 */
export const listDueReminders = async (
  db: Database,
  { now, limit = 100 }: { now: Date; limit?: number },
) =>
  db.reminder.findMany({
    where: {
      status: 'PENDING',
      deliveryState: { in: ['PENDING', 'QUEUED'] },
      remindAt: { lte: now },
    },
    orderBy: [{ remindAt: 'asc' }, { id: 'asc' }],
    take: Math.min(Math.max(limit, 1), 500),
  });

/**
 * Claims a reminder for dispatch. `updateMany` on the exact state is the
 * compare-and-swap: returns true for exactly one concurrent caller.
 */
export const claimReminder = async (db: Database, reminderId: string, at: Date) => {
  const result = await db.reminder.updateMany({
    where: { id: reminderId, status: 'PENDING', deliveryState: 'PENDING' },
    data: { deliveryState: 'QUEUED', updatedAt: at },
  });

  return result.count === 1;
};

/** Marks a reminder delivered with its notification. */
export const completeReminder = async (db: Database, reminderId: string, deliveredAt: Date) => {
  const result = await db.reminder.updateMany({
    where: { id: reminderId, status: 'PENDING', deliveryState: 'QUEUED' },
    data: { status: 'COMPLETED', deliveryState: 'SENT', deliveredAt, failureReason: null },
  });

  return result.count === 1;
};

/** Marks a reminder skipped without a notification (e.g. notifications disabled). */
export const skipReminder = async (db: Database, reminderId: string, reason: string, at: Date) => {
  const result = await db.reminder.updateMany({
    where: { id: reminderId, status: 'PENDING' },
    data: {
      status: 'MISSED',
      deliveryState: 'SKIPPED',
      deliveredAt: at,
      failureReason: reason.slice(0, 500),
    },
  });

  return result.count === 1;
};

/** The CANCELLED transition, available to future cancellation surfaces. */
export const cancelReminder = async (db: Database, reminderId: string, at: Date) =>
  withDomainErrors('Reminder', () =>
    db.reminder.updateMany({
      where: { id: reminderId, status: 'PENDING' },
      data: { status: 'CANCELLED', deliveryState: 'SKIPPED', updatedAt: at },
    }),
  );
