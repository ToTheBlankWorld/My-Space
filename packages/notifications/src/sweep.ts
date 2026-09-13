import { audit, delivery, UniqueConstraintError, type Database } from '@space/database';
import type { Logger } from '@space/logger';
import {
  addCalendarDays,
  asTimeZone,
  calendarDateRange,
  instantAtLocalTime,
  toCalendarDate,
} from '@space/time';
import type { Clock } from '@space/time';
import type { CalendarDate, TaskStatus } from '@space/types';

import { consumeOutbox, type OutboxConsumeResult } from './outbox';
import { evaluateDailyBrief, type DailyCycleFacts, type UserNotificationSettings } from './policy';
import { dispatchReminders, type ReminderDispatchResult } from './reminders';
import type { NotificationDraft } from './types';

/**
 * The notification sweep.
 *
 * Runs on a single deterministic interval (the `space:notification-sweep`
 * schedule) and owns four steps: (1) daily-cycle reconcile — seed today's
 * briefs for users with minutes configured; (2) reminder dispatch; (3) outbox
 * consumption; (4) enqueue due email deliveries. There are deliberately no
 * per-user timers or thousands of scheduled jobs: one worker, bounded batches,
 * idempotent keys.
 */

export interface SweepDeps {
  db: Database;
  clock: Clock;
  logger: Logger;
  /** APP_URL — passed to policy for deep links. */
  appUrl: string;
  /** False when AgentMail isn't configured: deliveries stay PENDING, never faked. */
  emailProviderConfigured: boolean;
  /** Adds one delivery job to the worker queue. */
  enqueueDelivery: (payload: DeliveryPayload) => Promise<void>;
}

export interface DeliveryPayload {
  userId: string;
  notificationId: string;
  emailLogId: string;
  recipient: string;
  template: string;
  data: Record<string, unknown>;
}

export interface DailyCycleResult {
  created: number;
}

export interface DeliveryPreparationResult {
  prepared: number;
  /** Notifications with no attached email — skipped as in-app only. */
  inAppOnly: number;
  /** Kept PENDING because the email provider is not configured. */
  providerUnconfigured: number;
  /** Stale QUEUED rows with no email log at all — left for manual review. */
  staleWithoutLog: number;
  /** Claimed but `enqueueDelivery` rejected — reverted to PENDING for next sweep. */
  reverted: number;
}

export interface SweepResult {
  daily: DailyCycleResult;
  reminders: ReminderDispatchResult;
  outbox: OutboxConsumeResult;
  deliveries: DeliveryPreparationResult;
}

// ---------------------------------------------------------------------------
// Step 1 — daily-cycle reconcile
// ---------------------------------------------------------------------------

const OPEN_STATUSES: readonly TaskStatus[] = ['INBOX', 'PLANNED', 'IN_PROGRESS'];

const toDbDate = (date: CalendarDate | string): Date => {
  const [year, month, day] = date.split('-').map((part) => Number(part));
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
};

const TERMINAL_STATUSES: readonly TaskStatus[] = ['COMPLETED', 'CANCELLED'];

const countDayTasks = async (
  db: Database,
  userId: string,
  today: CalendarDate,
  timeZone: string,
): Promise<{ open: number; scheduledToday: number; completedToday: number; deadlines: number }> => {
  const { start, end } = calendarDateRange(today, timeZone);

  const [open, scheduledToday, completedToday, deadlines] = await Promise.all([
    db.task.count({ where: { userId, status: { in: [...OPEN_STATUSES] } } }),
    db.task.count({
      where: {
        userId,
        status: { notIn: [...TERMINAL_STATUSES] },
        scheduledStart: { gte: start, lt: end },
      },
    }),
    db.task.count({ where: { userId, completedAt: { gte: start, lte: end } } }),
    db.task.count({
      where: { userId, dueAt: { gte: start, lte: end }, status: { in: [...OPEN_STATUSES] } },
    }),
  ]);

  return { open, scheduledToday, completedToday, deadlines };
};

type MinuteSlot = { slot: 'morning' | 'midday' | 'evening'; minute: number; scheduledAt: Date };

const buildUserCycle = async (
  db: Database,
  {
    userId,
    settings,
    userEmail,
    now,
  }: {
    userId: string;
    settings: UserNotificationSettings;
    userEmail: string | null;
    now: Date;
  },
): Promise<{
  bundle: { settings: UserNotificationSettings; userEmail: string | null; facts: DailyCycleFacts };
  todaysSlots: MinuteSlot[];
} | null> => {
  const { timeZone } = settings;
  const today: CalendarDate = toCalendarDate(now, timeZone);
  const tomorrowDate = addCalendarDays(today, 1);

  const configured = [
    { slot: 'morning' as const, minute: settings.morningNotificationMinute },
    { slot: 'midday' as const, minute: settings.middayNotificationMinute },
    { slot: 'evening' as const, minute: settings.eveningNotificationMinute },
  ].filter((candidate): candidate is MinuteSlot & { minute: number } => candidate.minute !== null);

  if (configured.length === 0) {
    return null;
  }

  const todaysSlots: MinuteSlot[] = configured.map(({ slot, minute }) => ({
    slot,
    minute,
    scheduledAt: instantAtLocalTime(today, minute, timeZone),
  }));

  const [tomorrowSpace, taskCounts] = await Promise.all([
    db.space.findFirst({
      where: { userId, date: toDbDate(tomorrowDate) },
      select: { plannedAt: true },
    }),
    countDayTasks(db, userId, today, timeZone),
  ]);

  const facts: DailyCycleFacts = {
    userId,
    today,
    tomorrowDate,
    tomorrowPlanned: tomorrowSpace !== null && tomorrowSpace.plannedAt !== null,
    openTaskCount: taskCounts.open,
    scheduledTodayCount: taskCounts.scheduledToday,
    completedTodayCount: taskCounts.completedToday,
    deadlineCount: taskCounts.deadlines,
  };

  return { bundle: { settings, userEmail, facts }, todaysSlots };
};

export const reconcileDailyCycles = async (deps: SweepDeps): Promise<DailyCycleResult> => {
  const { db, clock, logger, appUrl } = deps;
  const now = clock.now();

  const prefs = await db.userPreferences.findMany({ where: { notificationsEnabled: true } });
  if (prefs.length === 0) {
    return { created: 0 };
  }

  const emails = await db.user.findMany({
    where: { id: { in: prefs.map((row) => row.userId) } },
    select: { id: true, email: true },
  });
  const emailById = new Map(emails.map((row) => [row.id, row.email]));

  let created = 0;

  for (const prefsRow of prefs) {
    const settings: UserNotificationSettings = {
      notificationsEnabled: prefsRow.notificationsEnabled,
      emailNotificationsEnabled: prefsRow.emailNotificationsEnabled,
      timeZone: asTimeZone(prefsRow.timeZone),
      morningNotificationMinute: prefsRow.morningNotificationMinute,
      middayNotificationMinute: prefsRow.middayNotificationMinute,
      eveningNotificationMinute: prefsRow.eveningNotificationMinute,
    };

    const cycle = await buildUserCycle(db, {
      userId: prefsRow.userId,
      settings,
      userEmail: emailById.get(prefsRow.userId) ?? null,
      now,
    });
    if (cycle === null) {
      continue;
    }

    for (const slot of cycle.todaysSlots) {
      if (slot.scheduledAt > now) {
        continue;
      }

      const draft = evaluateDailyBrief(cycle.bundle.settings, cycle.bundle.facts, slot, appUrl);
      if (draft === null) {
        continue;
      }

      created += await createDraft(deps, draft, {
        userId: cycle.bundle.facts.userId,
        occurredAt: clock.now(),
        email:
          draft.email !== undefined && cycle.bundle.settings.emailNotificationsEnabled
            ? cycle.bundle.userEmail
            : null,
      });
    }
  }

  logger.info({ created }, 'notification: daily cycle reconciled');
  return { created };
};

/**
 * Persists one notification draft + its NOTIFICATION_CREATED event + its email
 * leg in a single transaction, idempotently on `deliveryKey`.
 *
 * Unique the key (physical constraint, not a get-then-create) is what makes a
 * concurrent sweep or an overlapping outbox batch a no-op rather than a bug.
 */
export const createDraft = async (
  deps: Pick<SweepDeps, 'db'>,
  draft: NotificationDraft,
  options: { userId: string; occurredAt: Date; email: string | null },
): Promise<number> => {
  const { db } = deps;
  const { userId, email } = options;

  return db.$transaction(async (tx) => {
    let notificationId: string;
    try {
      const notification = await delivery.createNotification(
        tx,
        userId,
        {
          type: draft.type,
          priority: draft.priority,
          title: draft.title,
          body: draft.body,
          scheduledAt: draft.scheduledAt,
        },
        { deliveryKey: draft.deliveryKey, linkUrl: draft.linkUrl },
      );
      notificationId = notification.id;
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        return 0;
      }
      throw error;
    }

    await audit.appendEvent(tx, userId, {
      eventType: 'NOTIFICATION_CREATED',
      aggregateType: 'NOTIFICATION',
      aggregateId: notificationId,
      payload: { type: draft.type, priority: draft.priority, deliveryKey: draft.deliveryKey },
      occurredAt: options.occurredAt,
    });

    if (draft.email !== undefined && email !== null) {
      await delivery.recordEmail(tx, {
        userId,
        recipient: email,
        template: draft.email.template,
        provider: 'agentmail',
        status: 'QUEUED',
        data: draft.email.data,
        notificationId,
      });
    }

    return 1;
  });
};

// ---------------------------------------------------------------------------
// Step 4 — prepare deliveries
// ---------------------------------------------------------------------------

export const prepareDeliveries = async (
  deps: SweepDeps,
  { staleQueuedAfterMinutes = 10 }: { staleQueuedAfterMinutes?: number } = {},
): Promise<DeliveryPreparationResult> => {
  const { db, clock, logger } = deps;
  const now = clock.now();

  const eligible = await delivery.listDispatchableNotifications(db, {
    now,
    staleQueuedAfterMinutes,
  });
  const result: DeliveryPreparationResult = {
    prepared: 0,
    inAppOnly: 0,
    providerUnconfigured: 0,
    staleWithoutLog: 0,
    reverted: 0,
  };

  for (const notification of eligible) {
    const emailLog = await db.emailLog.findFirst({
      where: { notificationId: notification.id },
      orderBy: { createdAt: 'desc' },
    });

    if (emailLog === null) {
      if (notification.deliveryState === 'PENDING') {
        await delivery.markNotificationSkipped(db, notification.id, 'in-app-only', now);
        result.inAppOnly += 1;
      } else {
        result.staleWithoutLog += 1;
        logger.warn(
          { notificationId: notification.id },
          'notification: stale QUEUED row without an email log',
        );
      }
      continue;
    }

    if (emailLog.status === 'SENT' || emailLog.status === 'DELIVERED') {
      if (notification.deliveryState === 'QUEUED') {
        await delivery.markNotificationSent(db, notification.id, now);
      }
      continue;
    }

    if (emailLog.status === 'BOUNCED') {
      if (notification.deliveryState === 'QUEUED') {
        await delivery.markNotificationFailed(db, notification.id, 'provider-bounced', now);
      }
      continue;
    }

    if (notification.deliveryState === 'PENDING') {
      if (!deps.emailProviderConfigured) {
        result.providerUnconfigured += 1;
        continue;
      }
      const claimed = await delivery.claimNotificationForDispatch(db, notification.id, now);
      if (!claimed) {
        continue;
      }
    } else if (!deps.emailProviderConfigured) {
      result.providerUnconfigured += 1;
      continue;
    }

    try {
      await deps.enqueueDelivery({
        userId: notification.userId,
        notificationId: notification.id,
        emailLogId: emailLog.id,
        recipient: emailLog.recipient,
        template: emailLog.template,
        data: (emailLog.data ?? {}) as Record<string, unknown>,
      });
      result.prepared += 1;
    } catch (error) {
      await db.notification.updateMany({
        where: { id: notification.id, deliveryState: 'QUEUED' },
        data: { deliveryState: 'PENDING', updatedAt: now },
      });
      result.reverted += 1;
      logger.error(
        {
          notificationId: notification.id,
          error: error instanceof Error ? error.message : 'unknown',
        },
        'notification: enqueue failed, reverted to PENDING',
      );
    }
  }

  return result;
};

// ---------------------------------------------------------------------------
// The sweep, composed.
// ---------------------------------------------------------------------------

export const runSweep = async (
  deps: SweepDeps,
  opts: { batchSize?: number; limit?: number } = {},
): Promise<SweepResult> => {
  const daily = await reconcileDailyCycles(deps);
  const reminders = await dispatchReminders(deps, { limit: opts.limit });
  const outbox = await consumeOutbox(deps, { batchSize: opts.batchSize });
  const deliveries = await prepareDeliveries(deps);

  deps.logger.info(
    {
      dailyCreated: daily.created,
      remindersAttempted: reminders.attempted,
      outboxRead: outbox.eventsRead,
      deliveriesPrepared: deliveries.prepared,
      providerConfigured: deps.emailProviderConfigured,
    },
    'notification: sweep finished',
  );

  return { daily, reminders, outbox, deliveries };
};
