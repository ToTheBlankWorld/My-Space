import { audit, delivery, type Database } from '@space/database';
import { UniqueConstraintError } from '@space/database';
import type { Logger } from '@space/logger';
import { planningCompletedPayloadSchema } from '@space/planning';
import { asTimeZone, fromDatabaseDate } from '@space/time';
import type { Clock } from '@space/time';

import {
  evaluatePlanCompletion,
  type PreviousPlanSummary,
  type UserNotificationSettings,
} from './policy';

/**
 * The outbox consumer ("notification-policy").
 *
 * `EventLog` is a transactional outbox: events are committed atomically with the
 * domain change that caused them. This consumer reads the log in `sequence`
 * order, turns selected events into notification drafts, persists those drafts
 * *in the same unit of work* as advancing its cursor, and is safe to replay
 * because every draft carries a stable idempotency key.
 *
 * Only PLANNING_COMPLETED is acted on today. Everything else is skipped
 * eagerly (never held behind the cursor) so a future consumer of those event
 * types can add itself without this one stalling.
 */

/** Owner of the `outbox_cursors` row this consumer advances. */
export const PROCESSOR_NAME = 'notification-policy';

export interface OutboxDeps {
  db: Database;
  clock: Clock;
  logger: Logger;
  /** APP_URL — the only deployment config policy touches (deep links). */
  appUrl: string;
}

export interface OutboxConsumeResult {
  eventsRead: number;
  /** Events skipped as poison (unparseable) or unrelated to any policy. */
  eventsSkipped: number;
  /** Drafts the plan-completion policy accepted. */
  drafts: number;
  /** Drafts that actually became new Notification rows (excluding replays). */
  created: number;
  /** Cursor position after the batch; pass back as `afterSequence`. */
  cursor: string | null;
}

const parseSettings = (row: {
  notificationsEnabled: boolean;
  emailNotificationsEnabled: boolean;
  timeZone: string;
  morningNotificationMinute: number | null;
  middayNotificationMinute: number | null;
  eveningNotificationMinute: number | null;
}): UserNotificationSettings => ({
  notificationsEnabled: row.notificationsEnabled,
  emailNotificationsEnabled: row.emailNotificationsEnabled,
  timeZone: asTimeZone(row.timeZone),
  morningNotificationMinute: row.morningNotificationMinute,
  middayNotificationMinute: row.middayNotificationMinute,
  eveningNotificationMinute: row.eveningNotificationMinute,
});

const readPreviousSummary = async (
  db: Database,
  { userId, spaceId, beforeSequence }: { userId: string; spaceId: string; beforeSequence: string },
): Promise<PreviousPlanSummary | null> => {
  const previous = await db.eventLog.findFirst({
    where: {
      userId,
      aggregateId: spaceId,
      eventType: 'PLANNING_COMPLETED',
      sequence: { lt: BigInt(beforeSequence) },
    },
    orderBy: { sequence: 'desc' },
  });

  if (previous === null) {
    return null;
  }

  const parsed = planningCompletedPayloadSchema.safeParse(previous.payload);
  if (!parsed.success) {
    return null;
  }

  return {
    scheduled: parsed.data.scheduled,
    unscheduled: parsed.data.unscheduled,
    conflicts: parsed.data.conflicts.length,
  };
};

export const consumeOutbox = async (
  deps: OutboxDeps,
  { batchSize = 100 }: { batchSize?: number } = {},
): Promise<OutboxConsumeResult> => {
  const { db, clock, logger, appUrl } = deps;

  const cursorRow = await audit.getOutboxCursor(db, PROCESSOR_NAME);
  const batch = await audit.readEventOutbox(db, {
    afterSequence: cursorRow?.lastSequence ?? null,
    eventType: 'PLANNING_COMPLETED',
    limit: batchSize,
  });
  const events = batch.events;

  if (events.length === 0) {
    return {
      eventsRead: 0,
      eventsSkipped: 0,
      drafts: 0,
      created: 0,
      cursor: cursorRow?.lastSequence ?? null,
    };
  }

  const planEvents = events.filter((event) => event.eventType === 'PLANNING_COMPLETED');
  if (planEvents.length === 0) {
    const lastSequence = events[events.length - 1]?.sequence ?? null;
    await audit.advanceOutboxCursor(db, PROCESSOR_NAME, lastSequence ?? BigInt(0));
    return {
      eventsRead: events.length,
      eventsSkipped: events.length,
      drafts: 0,
      created: 0,
      cursor: lastSequence,
    };
  }

  const userIds = [...new Set(planEvents.map((event) => event.userId))];
  const spaceIds = [...new Set(planEvents.map((event) => event.aggregateId))];

  const [preferences, spaceRows, userRows] = await Promise.all([
    db.userPreferences.findMany({ where: { userId: { in: userIds } } }),
    db.space.findMany({
      where: { id: { in: spaceIds } },
      select: { id: true, userId: true, date: true },
    }),
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }),
  ]);

  const settingsById = new Map(
    userIds.map((id) => [id, preferences.find((row) => row.userId === id)]),
  );
  const emailById = new Map(
    userIds.map((id) => [id, userRows.find((row) => row.id === id)?.email ?? null]),
  );
  const spaceById = new Map(spaceIds.map((id) => [id, spaceRows.find((row) => row.id === id)]));

  const drafts: Array<{
    event: (typeof events)[number];
    draft: NonNullable<ReturnType<typeof evaluatePlanCompletion>>;
  }> = [];
  let skippedPoison = 0;

  for (const event of planEvents) {
    const parsed = planningCompletedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      skippedPoison += 1;
      logger.error(
        { eventId: event.id, sequence: event.sequence, error: parsed.error.message },
        'outbox: poison PLANNING_COMPLETED payload, advancing cursor',
      );
      continue;
    }

    const space = spaceById.get(event.aggregateId);
    if (space === undefined) {
      skippedPoison += 1;
      logger.warn(
        { eventId: event.id, spaceId: event.aggregateId },
        'outbox: space gone, skipping plan event',
      );
      continue;
    }

    const settings = settingsById.get(event.userId) ?? null;
    if (settings === null) {
      skippedPoison += 1;
      logger.warn(
        { eventId: event.id, userId: event.userId },
        'outbox: no preferences, skipping plan event',
      );
      continue;
    }

    const previous = await readPreviousSummary(db, {
      userId: event.userId,
      spaceId: event.aggregateId,
      beforeSequence: event.sequence,
    });

    const draft = evaluatePlanCompletion(
      parseSettings(settings),
      {
        userId: event.userId,
        spaceId: event.aggregateId,
        date: fromDatabaseDate(space.date),
        planVersion: parsed.data.planVersion,
        mode: parsed.data.mode,
        applied: parsed.data.mode !== 'suggest-only',
        scheduled: parsed.data.scheduled,
        unscheduled: parsed.data.unscheduled,
        conflicts: parsed.data.conflicts.length,
      },
      previous,
      appUrl,
    );

    if (draft !== null) {
      drafts.push({ event, draft });
    }
  }

  const lastSequence = events[events.length - 1]?.sequence ?? null;
  if (lastSequence === null) {
    return {
      eventsRead: events.length,
      eventsSkipped: skippedPoison,
      drafts: 0,
      created: 0,
      cursor: null,
    };
  }

  let created = 0;

  await db.$transaction(async (tx) => {
    for (const { event, draft } of drafts) {
      const settings = settingsById.get(event.userId);
      const emailAddress = emailById.get(event.userId) ?? null;
      const prefs = settings === undefined ? undefined : parseSettings(settings);

      let notificationId: string;
      try {
        const notification = await delivery.createNotification(
          tx,
          event.userId,
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
        created += 1;
      } catch (error) {
        // A duplicate `deliveryKey` is a replay of an already-applied event:
        // the cursor still advances because the batch applies at-least-once,
        // safely, thanks to the physical unique index.
        if (error instanceof UniqueConstraintError) {
          continue;
        }
        throw error;
      }

      await audit.appendEvent(tx, event.userId, {
        eventType: 'NOTIFICATION_CREATED',
        aggregateType: 'NOTIFICATION',
        aggregateId: notificationId,
        payload: {
          type: draft.type,
          priority: draft.priority,
          deliveryKey: draft.deliveryKey,
        },
        occurredAt: clock.now(),
        correlationId: event.correlationId ?? undefined,
        causationId: event.id,
      });

      if (
        draft.email !== undefined &&
        prefs?.emailNotificationsEnabled === true &&
        emailAddress !== null
      ) {
        await delivery.recordEmail(tx, {
          userId: event.userId,
          recipient: emailAddress,
          template: draft.email.template,
          provider: 'agentmail',
          status: 'QUEUED',
          data: draft.email.data,
          notificationId,
        });
      }
    }

    await audit.advanceOutboxCursor(tx, PROCESSOR_NAME, lastSequence);
  });

  return {
    eventsRead: events.length,
    eventsSkipped: skippedPoison,
    drafts: drafts.length,
    created,
    cursor: lastSequence,
  };
};
