import type { Database } from '@space/database';
import type { CalendarDate, EventType, TimeZone } from '@space/types';
import { asTimeZone, toCalendarDate, toDatabaseDate } from '@space/time';

import type { AffectedSpace } from './types';
import { resolveTriggerNode } from './trigger-graph';

/**
 * Affected-space detection.
 *
 * Given an event, determines which Space(s) are potentially affected and need
 * to be evaluated for replanning. The resolution depends on the event's trigger
 * node:
 *
 *   EVENT_DATE   — the event aggregate is a Task/Reminder; the Space is the
 *                  task's spaceId (if set) or the space for the task's date.
 *   CALENDAR_SYNC — the event came from calendar sync; affected dates are the
 *                  calendar events' start dates in the user's timezone.
 *   USER_SCOPE   — all of the user's active spaces (rare: working-hours changes).
 *   DEADLINE_SCAN — the task's spaceId, like EVENT_DATE.
 *
 * Every query is scoped by userId. No cross-user data access.
 *
 * This module depends on the database for space/task/event lookups. It never
 * writes — it is a pure query layer that returns candidates for the service
 * to evaluate.
 */

export interface ResolveAffectedSpacesArgs {
  db: Database;
  userId: string;
  /** The event type that fired. */
  eventType: EventType;
  /** The aggregate ID from the event (task ID, calendar connection ID, etc.). */
  aggregateId: string;
  /** The aggregate type from the event. */
  aggregateType: string;
  /** The event's occurredAt timestamp, for calendar-sync date resolution. */
  occurredAt: Date;
  /** Optional payload from the event (e.g. calendarId for CALENDAR_CHANGED). */
  payload?: Record<string, unknown>;
}

/**
 * Resolves the Space(s) potentially affected by an event.
 *
 * Returns a deduplicated list of Spaces that the review pipeline should
 * evaluate. The list may be empty (the event does not touch any planned Space)
 * or contain multiple entries (calendar sync affecting multiple dates).
 */
export const resolveAffectedSpaces = async (
  args: ResolveAffectedSpacesArgs,
): Promise<AffectedSpace[]> => {
  const { db, userId, eventType, aggregateId, aggregateType, payload, occurredAt } = args;
  const node = resolveTriggerNode(eventType);

  switch (node.resolutionStrategy) {
    case 'EVENT_DATE':
      return resolveByEventDate(db, userId, aggregateId, aggregateType);
    case 'CALENDAR_SYNC':
      return resolveByCalendarSync(db, userId, payload, occurredAt);
    case 'USER_SCOPE':
      return resolveByUserScope(db, userId);
    case 'DEADLINE_SCAN':
      return resolveByDeadlineScan(db, userId, aggregateId);
    default:
      return [];
  }
};

/**
 * Resolve by the event's aggregate: the task's spaceId or its scheduled date.
 */
const resolveByEventDate = async (
  db: Database,
  userId: string,
  aggregateId: string,
  aggregateType: string,
): Promise<AffectedSpace[]> => {
  if (aggregateType === 'TASK') {
    const task = await db.task.findFirst({
      where: { id: aggregateId, userId },
      select: {
        id: true,
        spaceId: true,
        scheduledStart: true,
        dueAt: true,
      },
    });
    if (!task) return [];

    // If the task has a spaceId, find that space directly.
    if (task.spaceId) {
      const space = await db.space.findFirst({
        where: { id: task.spaceId, userId },
        select: {
          id: true,
          userId: true,
          date: true,
          timeZone: true,
          planVersion: true,
          optimizedAt: true,
        },
      });
      if (space) {
        return [
          {
            userId: space.userId,
            spaceId: space.id,
            date: toCalendarDate(space.date, space.timeZone),
            timeZone: asTimeZone(space.timeZone),
            planVersion: space.planVersion,
            optimizedAt: space.optimizedAt,
          },
        ];
      }
    }

    // Fallback: find the space for the task's scheduled date or due date.
    const referenceDate = task.scheduledStart ?? task.dueAt;
    if (!referenceDate) return [];

    const timeZone = await resolveUserTimeZone(db, userId);
    const date = toCalendarDate(referenceDate, timeZone);
    return findSpaceForDate(db, userId, date);
  }

  if (aggregateType === 'REMINDER') {
    const reminder = await db.reminder.findFirst({
      where: { id: aggregateId, userId },
      select: { id: true, spaceId: true, remindAt: true },
    });
    if (!reminder) return [];

    if (reminder.spaceId) {
      const space = await db.space.findFirst({
        where: { id: reminder.spaceId, userId },
        select: {
          id: true,
          userId: true,
          date: true,
          timeZone: true,
          planVersion: true,
          optimizedAt: true,
        },
      });
      if (space) {
        return [
          {
            userId: space.userId,
            spaceId: space.id,
            date: toCalendarDate(space.date, space.timeZone),
            timeZone: asTimeZone(space.timeZone),
            planVersion: space.planVersion,
            optimizedAt: space.optimizedAt,
          },
        ];
      }
    }

    const timeZone = await resolveUserTimeZone(db, userId);
    const date = toCalendarDate(reminder.remindAt, timeZone);
    return findSpaceForDate(db, userId, date);
  }

  return [];
};

/**
 * Resolve by calendar sync: find calendar events in the replan horizon,
 * then find Spaces for the dates those events fall on.
 */
const resolveByCalendarSync = async (
  db: Database,
  userId: string,
  payload: Record<string, unknown> | undefined,
  occurredAt: Date,
): Promise<AffectedSpace[]> => {
  const calendarId = payload?.calendarId as string | undefined;
  if (!calendarId) return [];

  const timeZone = await resolveUserTimeZone(db, userId);
  const horizonMs = 72 * 60 * 60 * 1000; // 72 hours
  const horizonStart = new Date(occurredAt.getTime() - horizonMs);
  const horizonEnd = new Date(occurredAt.getTime() + horizonMs);

  // Find calendar events from this calendar in the horizon.
  const calEvents = await db.calendarEvent.findMany({
    where: {
      userId,
      calendarId,
      deletedAt: null,
      startAt: { lt: horizonEnd },
      endAt: { gt: horizonStart },
    },
    select: { startAt: true },
  });

  if (calEvents.length === 0) return [];

  // Deduplicate dates.
  const dateSet = new Set<CalendarDate>();
  for (const event of calEvents) {
    dateSet.add(toCalendarDate(event.startAt, timeZone));
  }

  const spaces: AffectedSpace[] = [];
  for (const date of dateSet) {
    const found = await findSpaceForDate(db, userId, date);
    spaces.push(...found);
  }

  return spaces;
};

/**
 * Resolve by user scope: find all DRAFT/ACTIVE spaces with planned work.
 */
const resolveByUserScope = async (db: Database, userId: string): Promise<AffectedSpace[]> => {
  const rows = await db.space.findMany({
    where: { userId, status: { in: ['DRAFT', 'ACTIVE'] }, planVersion: { gt: 0 } },
    select: {
      id: true,
      userId: true,
      date: true,
      timeZone: true,
      planVersion: true,
      optimizedAt: true,
    },
    orderBy: { date: 'desc' },
    take: 10, // Bounded: only recent/future spaces.
  });

  return rows.map((row) => ({
    userId: row.userId,
    spaceId: row.id,
    date: toCalendarDate(row.date, row.timeZone),
    timeZone: asTimeZone(row.timeZone),
    planVersion: row.planVersion,
    optimizedAt: row.optimizedAt,
  }));
};

/**
 * Resolve by deadline scan: find the task's space for deadline risk evaluation.
 */
const resolveByDeadlineScan = async (
  db: Database,
  userId: string,
  aggregateId: string,
): Promise<AffectedSpace[]> => {
  const task = await db.task.findFirst({
    where: { id: aggregateId, userId },
    select: { id: true, spaceId: true, dueAt: true },
  });
  if (!task || !task.spaceId) return [];

  const space = await db.space.findFirst({
    where: { id: task.spaceId, userId },
    select: {
      id: true,
      userId: true,
      date: true,
      timeZone: true,
      planVersion: true,
      optimizedAt: true,
    },
  });
  if (!space) return [];

  return [
    {
      userId: space.userId,
      spaceId: space.id,
      date: toCalendarDate(space.date, space.timeZone),
      timeZone: asTimeZone(space.timeZone),
      planVersion: space.planVersion,
      optimizedAt: space.optimizedAt,
    },
  ];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const resolveUserTimeZone = async (db: Database, userId: string): Promise<TimeZone> => {
  const prefs = await db.userPreferences.findUnique({
    where: { userId },
    select: { timeZone: true },
  });
  return asTimeZone(prefs?.timeZone ?? 'UTC');
};

const findSpaceForDate = async (
  db: Database,
  userId: string,
  date: CalendarDate,
): Promise<AffectedSpace[]> => {
  const dateDb = toDatabaseDate(date);
  const row = await db.space.findFirst({
    where: { userId, date: dateDb },
    select: {
      id: true,
      userId: true,
      date: true,
      timeZone: true,
      planVersion: true,
      optimizedAt: true,
    },
  });
  if (!row) return [];

  return [
    {
      userId: row.userId,
      spaceId: row.id,
      date: toCalendarDate(row.date, row.timeZone),
      timeZone: asTimeZone(row.timeZone),
      planVersion: row.planVersion,
      optimizedAt: row.optimizedAt,
    },
  ];
};
