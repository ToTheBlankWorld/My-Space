import type { CalendarProvider, ConnectionStatus } from '@space/types';
import { parseOrThrow, upsertCalendarEventSchema } from '@space/validation';
import { type z } from 'zod';

import type { Database } from '../client';
import { withDomainErrors } from '../errors';

/**
 * The calendar mirror.
 *
 * Space is the source of truth for *planned work*; an external calendar is the
 * source of truth for *its own events*. These functions maintain the local copy
 * of the second so the engines can reason about a user's real day without a
 * network call.
 *
 * No provider API is called from this package — Stage 4 owns that. What exists
 * here is the storage contract a sync must satisfy, above all idempotency.
 */

export type UpsertCalendarEventInput = z.input<typeof upsertCalendarEventSchema>;

export interface UpsertConnectionInput {
  provider: CalendarProvider;
  providerAccountId: string;
  status?: ConnectionStatus;
  grantedScopes?: string | null;
}

/**
 * Creates or updates a provider connection.
 *
 * Keyed on `(userId, provider, providerAccountId)` so re-authorising the same
 * Google account updates the existing row instead of accumulating duplicates.
 * No token is stored: credentials arrive in Stage 3 with encryption at rest.
 */
export const upsertCalendarConnection = async (
  db: Database,
  userId: string,
  input: UpsertConnectionInput,
) =>
  withDomainErrors('CalendarConnection', () =>
    db.calendarConnection.upsert({
      where: {
        userId_provider_providerAccountId: {
          userId,
          provider: input.provider,
          providerAccountId: input.providerAccountId,
        },
      },
      create: {
        userId,
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        status: input.status ?? 'CONNECTED',
        grantedScopes: input.grantedScopes ?? null,
      },
      update: {
        status: input.status ?? 'CONNECTED',
        grantedScopes: input.grantedScopes ?? null,
      },
    }),
  );

export interface UpsertCalendarInput {
  connectionId: string;
  externalId: string;
  name: string;
  timeZone: string;
  description?: string | null;
  isPrimary?: boolean;
  isSelected?: boolean;
  color?: string | null;
}

export const upsertCalendar = async (db: Database, userId: string, input: UpsertCalendarInput) =>
  withDomainErrors('Calendar', () =>
    db.calendar.upsert({
      where: {
        connectionId_externalId: {
          connectionId: input.connectionId,
          externalId: input.externalId,
        },
      },
      create: {
        userId,
        connectionId: input.connectionId,
        externalId: input.externalId,
        name: input.name,
        description: input.description ?? null,
        timeZone: input.timeZone,
        isPrimary: input.isPrimary ?? false,
        isSelected: input.isSelected ?? true,
        color: input.color ?? null,
      },
      update: {
        name: input.name,
        description: input.description ?? null,
        timeZone: input.timeZone,
        isPrimary: input.isPrimary ?? false,
        color: input.color ?? null,
      },
    }),
  );

/**
 * Stores an event from a provider.
 *
 * Idempotent on `(calendarId, externalId)`: re-running a sync, or replaying a
 * webhook the provider delivered twice, updates the same row rather than
 * inserting a duplicate. This is the constraint the whole sync design rests on.
 */
export const upsertCalendarEvent = async (
  db: Database,
  userId: string,
  input: UpsertCalendarEventInput,
  { syncedAt }: { syncedAt: Date },
) => {
  const data = parseOrThrow(upsertCalendarEventSchema, input, 'calendar event');

  if (data.endAt.getTime() < data.startAt.getTime()) {
    throw new RangeError('Calendar event ends before it starts.');
  }

  const shared = {
    title: data.title,
    description: data.description ?? null,
    location: data.location ?? null,
    startAt: data.startAt,
    endAt: data.endAt,
    timeZone: data.timeZone,
    isAllDay: data.isAllDay,
    status: data.status,
    syncState: data.syncState,
    externalEtag: data.externalEtag ?? null,
    lastSyncedAt: syncedAt,
    // An event that reappears upstream is resurrected rather than duplicated.
    deletedAt: null,
  };

  return withDomainErrors('CalendarEvent', () =>
    db.calendarEvent.upsert({
      where: {
        calendarId_externalId: { calendarId: data.calendarId, externalId: data.externalId },
      },
      create: {
        userId,
        calendarId: data.calendarId,
        externalId: data.externalId,
        provider: 'GOOGLE',
        ...shared,
      },
      update: shared,
    }),
  );
};

/**
 * Events overlapping a half-open instant window.
 *
 * The overlap predicate is `startAt < end AND endAt > start`, which is the
 * correct test for two half-open intervals: an event ending exactly when the
 * window opens does not overlap it.
 */
export const listCalendarEventsInRange = async (
  db: Database,
  userId: string,
  { start, end, limit = 500 }: { start: Date; end: Date; limit?: number },
) =>
  db.calendarEvent.findMany({
    where: {
      userId,
      deletedAt: null,
      status: { not: 'CANCELLED' },
      startAt: { lt: end },
      endAt: { gt: start },
    },
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    take: Math.min(Math.max(limit, 1), 1000),
  });

/** Marks an event removed upstream without losing the row a plan referenced. */
export const softDeleteCalendarEvent = async (
  db: Database,
  userId: string,
  {
    calendarId,
    externalId,
    deletedAt,
  }: { calendarId: string; externalId: string; deletedAt: Date },
) => {
  const result = await db.calendarEvent.updateMany({
    where: { userId, calendarId, externalId },
    data: { deletedAt, status: 'CANCELLED', syncState: 'SYNCED' },
  });

  return result.count === 1;
};

/** Records the provider's incremental sync cursor after a successful pass. */
export const recordSyncCursor = async (
  db: Database,
  userId: string,
  connectionId: string,
  { cursor, syncedAt }: { cursor: string | null; syncedAt: Date },
) => {
  const result = await db.calendarConnection.updateMany({
    where: { id: connectionId, userId },
    data: { syncCursor: cursor, lastSyncedAt: syncedAt, status: 'CONNECTED' },
  });

  return result.count === 1;
};
