import { addCalendarDays, fromDatabaseDate, toDatabaseDate } from '@space/time';
import type { CalendarDate, SpaceStatus, TimeZone } from '@space/types';
import { createSpaceSchema, parseOrThrow } from '@space/validation';
import { type z } from 'zod';

import type { Database } from '../client';
import { withDomainErrors } from '../errors';

/**
 * Spaces: one plan per user per calendar date.
 *
 * Calendar dates cross this boundary as `YYYY-MM-DD` strings and are converted
 * to a `date` column here, in one place. No caller ever hands a `Date` to a
 * Space query, which is what keeps the server's own timezone out of the model.
 */

export type CreateSpaceInput = z.input<typeof createSpaceSchema>;

export const spaceFields = {
  id: true,
  userId: true,
  date: true,
  timeZone: true,
  status: true,
  summary: true,
  plannedAt: true,
  optimizedAt: true,
  planVersion: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface SpaceRow {
  date: Date;
}

/** Replaces the raw `date` column with the calendar date callers work in. */
export const withCalendarDate = <T extends SpaceRow>(
  row: T,
): Omit<T, 'date'> & { date: CalendarDate } => ({
  ...row,
  date: fromDatabaseDate(row.date),
});

export const findSpaceByDate = async (
  db: Database,
  userId: string,
  date: CalendarDate | string,
) => {
  const row = await db.space.findUnique({
    // The composite unique key is also the natural lookup: one index serves both.
    where: { userId_date: { userId, date: toDatabaseDate(date) } },
    select: spaceFields,
  });

  return row ? withCalendarDate(row) : null;
};

/**
 * Returns the Space for a date, creating it if this is the first time the user
 * has looked at that day.
 *
 * `upsert` rather than find-then-create: two concurrent requests for the same
 * day (a page load racing a background planning pass) must not both insert and
 * trip the unique constraint.
 */
export const getOrCreateSpace = async (db: Database, userId: string, input: CreateSpaceInput) => {
  const data = parseOrThrow(createSpaceSchema, input, 'space');

  const row = await withDomainErrors('Space', () =>
    db.space.upsert({
      where: { userId_date: { userId, date: toDatabaseDate(data.date) } },
      create: {
        userId,
        date: toDatabaseDate(data.date),
        timeZone: data.timeZone,
        status: data.status,
        summary: data.summary ?? null,
      },
      // Deliberately a no-op: an existing plan is never overwritten by the act
      // of opening the day.
      update: {},
      select: spaceFields,
    }),
  );

  return withCalendarDate(row);
};

/**
 * Spaces across an inclusive range of calendar dates.
 *
 * Bounded by construction: a range is required, and it is capped, so "load my
 * whole history" is not expressible through this function.
 */
export const listSpacesInRange = async (
  db: Database,
  userId: string,
  from: CalendarDate | string,
  to: CalendarDate | string,
  { maxDays = 370 }: { maxDays?: number } = {},
) => {
  const start = toDatabaseDate(from);
  const endExclusive = toDatabaseDate(addCalendarDays(to, 1));
  const spannedDays = Math.round(
    (endExclusive.getTime() - start.getTime()) / (24 * 60 * 60 * 1000),
  );

  if (spannedDays <= 0) {
    return [];
  }

  if (spannedDays > maxDays) {
    throw new RangeError(`Range covers ${spannedDays} days; the maximum is ${maxDays}.`);
  }

  const rows = await db.space.findMany({
    where: { userId, date: { gte: start, lt: endExclusive } },
    orderBy: { date: 'asc' },
    select: spaceFields,
  });

  return rows.map(withCalendarDate);
};

export const updateSpaceStatus = async (
  db: Database,
  userId: string,
  spaceId: string,
  status: SpaceStatus,
) => {
  // `updateMany` with the owner in the predicate: an `update` by id alone would
  // let a caller mutate another user's Space by guessing an identifier.
  const result = await db.space.updateMany({
    where: { id: spaceId, userId },
    data: { status },
  });

  return result.count === 1;
};

/** Records that the engine produced a plan, bumping the version the UI watches. */
export const markSpacePlanned = async (
  db: Database,
  userId: string,
  spaceId: string,
  plannedAt: Date,
) => {
  const result = await db.space.updateMany({
    where: { id: spaceId, userId },
    data: { plannedAt, optimizedAt: plannedAt, planVersion: { increment: 1 }, status: 'ACTIVE' },
  });

  return result.count === 1;
};

/**
 * The ordered contents of a Space.
 *
 * One query returns the timeline with each item's concrete row attached, so
 * rendering a day is a single round trip instead of one query per item — the
 * N+1 this index table exists to prevent.
 *
 * The ordering is total: `position`, then start time (nulls last, because
 * unscheduled work sorts after scheduled work), then creation order, then id.
 * Two runs against unchanged data always produce the same sequence.
 */
export const getSpaceTimeline = async (db: Database, userId: string, spaceId: string) =>
  db.spaceItem.findMany({
    where: { spaceId, userId },
    orderBy: [
      { position: 'asc' },
      { scheduledStart: { sort: 'asc', nulls: 'last' } },
      { createdAt: 'asc' },
      { id: 'asc' },
    ],
    include: {
      task: true,
      reminder: true,
      calendarEvent: true,
    },
  });

export interface AttachToSpaceInput {
  spaceId: string;
  position?: number;
  scheduledStart?: Date | null;
  scheduledEnd?: Date | null;
}

/**
 * Places a task on a day's timeline.
 *
 * The item row is keyed by `taskId`, so re-placing an already-placed task moves
 * it rather than duplicating it.
 */
export const attachTaskToSpace = async (
  db: Database,
  userId: string,
  taskId: string,
  { spaceId, position = 0, scheduledStart = null, scheduledEnd = null }: AttachToSpaceInput,
) =>
  withDomainErrors('SpaceItem', () =>
    db.spaceItem.upsert({
      where: { taskId },
      create: {
        userId,
        spaceId,
        kind: 'TASK',
        taskId,
        position,
        scheduledStart,
        scheduledEnd,
      },
      update: { spaceId, position, scheduledStart, scheduledEnd },
    }),
  );

/** Places a reminder on a day's timeline. */
export const attachReminderToSpace = async (
  db: Database,
  userId: string,
  reminderId: string,
  { spaceId, position = 0, scheduledStart = null }: AttachToSpaceInput,
) =>
  withDomainErrors('SpaceItem', () =>
    db.spaceItem.upsert({
      where: { reminderId },
      create: {
        userId,
        spaceId,
        kind: 'REMINDER',
        reminderId,
        position,
        scheduledStart,
      },
      update: { spaceId, position, scheduledStart },
    }),
  );

/** Places a calendar event on a day's timeline. */
export const attachCalendarEventToSpace = async (
  db: Database,
  userId: string,
  calendarEventId: string,
  { spaceId, position = 0, scheduledStart = null, scheduledEnd = null }: AttachToSpaceInput,
) =>
  withDomainErrors('SpaceItem', () =>
    db.spaceItem.upsert({
      where: { calendarEventId },
      create: {
        userId,
        spaceId,
        kind: 'CALENDAR_EVENT',
        calendarEventId,
        position,
        scheduledStart,
        scheduledEnd,
      },
      update: { spaceId, position, scheduledStart, scheduledEnd },
    }),
  );

export interface SpaceIdentity {
  date: CalendarDate;
  timeZone: TimeZone;
}
