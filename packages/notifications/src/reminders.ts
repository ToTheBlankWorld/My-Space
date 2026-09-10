import {
  audit,
  delivery,
  reminders as remindersRepo,
  UniqueConstraintError,
  type Database,
} from '@space/database';
import type { Logger } from '@space/logger';
import { toCalendarDate } from '@space/time';
import type { Clock } from '@space/time';

import { REMINDER_OCCURRENCE_KEY } from './keys';
import type { EmailDirective } from './types';

/**
 * Reminder dispatcher.
 *
 * Reminders are domain intent; this dispatcher converts due reminders into
 * notifications. The reminder's own compare-and-swap claim guarantees exactly
 * one worker dispatches it; the notification's unique `deliveryKey` guarantees
 * the same reminder can never notify twice even if a queue redelivers the run.
 *
 * Recurrence is out of scope here: expanding a rule into occurrences is a later
 * stage (the schema columns already exist). This works on single reminders and
 * will move to the same claim/complete flow when expansion lands.
 */

export interface ReminderDispatchDeps {
  db: Database;
  clock: Clock;
  logger: Logger;
  /** APP_URL for the safe deep link back to the day the reminder fires on. */
  appUrl: string;
}

export interface ReminderDispatchResult {
  attempted: number;
  dispatched: number;
  /** Replays / concurrent duplicates that were idempotently absorbed. */
  duplicates: number;
  /** Reminders skipped because notifications are disabled for the user. */
  skipped: number;
}

const TASK_REMINDER_TEMPLATE = 'task-reminder' as const;

export const dispatchReminders = async (
  deps: ReminderDispatchDeps,
  { limit = 100 }: { limit?: number } = {},
): Promise<ReminderDispatchResult> => {
  const { db, clock, logger, appUrl } = deps;
  const now = clock.now();

  const due = await remindersRepo.listDueReminders(db, { now, limit });
  if (due.length === 0) {
    return { attempted: 0, dispatched: 0, duplicates: 0, skipped: 0 };
  }

  const userIds = [...new Set(due.map((reminder) => reminder.userId))];
  const emails = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true },
  });
  const emailById = new Map(
    userIds.map((id) => [id, emails.find((row) => row.id === id)?.email ?? null]),
  );

  const result: ReminderDispatchResult = { attempted: 0, dispatched: 0, duplicates: 0, skipped: 0 };

  for (const reminder of due) {
    result.attempted += 1;

    await db.$transaction(async (tx) => {
      // CAS claim: exactly one worker wins a reminder.
      const claimed = await remindersRepo.claimReminder(tx, reminder.id, now);
      if (!claimed) {
        return;
      }

      const row = await tx.reminder.findUnique({
        where: { id: reminder.id },
        include: { task: { select: { id: true, title: true, priority: true } } },
      });
      const prefs = await tx.userPreferences.findUnique({ where: { userId: reminder.userId } });
      if (row === null) {
        return;
      }

      // Master switch: notifications off means the intent is skipped, loudly and
      // with an event, so "why did I miss this" is answerable from the log.
      if (prefs === null || !prefs.notificationsEnabled) {
        await remindersRepo.skipReminder(tx, reminder.id, 'notifications-disabled', clock.now());
        await audit.appendEvent(tx, reminder.userId, {
          eventType: 'REMINDER_SKIPPED',
          aggregateType: 'REMINDER',
          aggregateId: reminder.id,
          payload: { reason: 'notifications-disabled', remindAt: reminder.remindAt.toISOString() },
          occurredAt: clock.now(),
        });
        result.skipped += 1;
        return;
      }

      const date = toCalendarDate(reminder.remindAt, reminder.timeZone);
      const planUrl = `${appUrl}/space/${date}`;
      const taskTitle = row.task?.title ?? reminder.title;

      const email: EmailDirective | undefined =
        prefs.emailNotificationsEnabled && (emailById.get(reminder.userId) ?? null) !== null
          ? {
              template: TASK_REMINDER_TEMPLATE,
              data: {
                taskId: row.task?.id ?? reminder.id,
                title: taskTitle,
                date,
                planUrl,
              },
            }
          : undefined;

      let notificationId: string;
      try {
        const notification = await delivery.createNotification(
          tx,
          reminder.userId,
          {
            type: 'TASK_REMINDER',
            priority: row.task?.priority === 'CRITICAL' ? 'IMPORTANT' : 'NORMAL',
            title: reminder.title,
            body: reminder.description ?? `Reminder: ${taskTitle}`,
            scheduledAt: null,
          },
          {
            deliveryKey: REMINDER_OCCURRENCE_KEY(reminder.id, 1),
            linkUrl: planUrl,
          },
        );
        notificationId = notification.id;
      } catch (error) {
        if (!(error instanceof UniqueConstraintError)) {
          throw error;
        }
        // Already dispatched in a previous (possibly redelivered) run — absorb.
        await remindersRepo.completeReminder(tx, reminder.id, clock.now());
        result.duplicates += 1;
        return;
      }

      await audit.appendEvent(tx, reminder.userId, {
        eventType: 'NOTIFICATION_CREATED',
        aggregateType: 'NOTIFICATION',
        aggregateId: notificationId,
        payload: {
          type: 'TASK_REMINDER',
          priority: 'NORMAL',
          deliveryKey: REMINDER_OCCURRENCE_KEY(reminder.id, 1),
        },
        occurredAt: clock.now(),
      });

      if (email !== undefined) {
        await delivery.recordEmail(tx, {
          userId: reminder.userId,
          recipient: emailById.get(reminder.userId) ?? '',
          template: email.template,
          provider: 'agentmail',
          status: 'QUEUED',
          data: email.data,
          notificationId,
        });
      }

      await audit.appendEvent(tx, reminder.userId, {
        eventType: 'REMINDER_TRIGGERED',
        aggregateType: 'REMINDER',
        aggregateId: reminder.id,
        payload: {
          notificationId,
          deliveryKey: REMINDER_OCCURRENCE_KEY(reminder.id, 1),
          occurrence: 1,
        },
        occurredAt: clock.now(),
      });

      await remindersRepo.completeReminder(tx, reminder.id, clock.now());
      result.dispatched += 1;
    });
  }

  if (result.dispatched > 0 || result.skipped > 0) {
    logger.info(result, 'notification: reminders dispatched');
  }

  return result;
};
