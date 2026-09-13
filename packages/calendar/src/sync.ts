import { audit, calendar as calendarRepository, type Database } from '@space/database';
import type { Logger } from '@space/logger';
import type { Clock } from '@space/time';

import { recordCalendarConnectionEvent } from './audit-events';
import type { CalendarProviderAdapter, ProviderCalendar, SyncResult } from './types';

/**
 * The calendar synchronization engine.
 *
 * This module owns the core sync logic. It is provider-agnostic: the
 * `CalendarProviderAdapter` interface is injected, so the same code runs
 * against Google today and any other provider later.
 *
 * Design principles:
 *   - Idempotent: re-running a sync cannot create duplicate events.
 *   - Deterministic: given the same inputs, the same database writes happen.
 *   - Ownership-safe: every write is scoped to the authenticated userId.
 *   - Retryable: transient failures surface as typed errors, not corruption.
 */

export interface SyncContext {
  db: Database;
  logger: Logger;
  clock: Clock;
  provider: CalendarProviderAdapter;
}

export interface SyncCalendarInput {
  userId: string;
  connectionId: string;
  calendarId: string;
  /** Decrypted OAuth access token. Caller is responsible for loading and decrypting. */
  accessToken: string;
  /** True to ignore the stored sync cursor and fetch everything, e.g. token expiry. */
  fullSync?: boolean;
}

export interface SyncConnectionInput {
  userId: string;
  connectionId: string;
  /** Decrypted OAuth access token. Caller is responsible for loading and decrypting. */
  accessToken: string;
  /** True to ignore the stored sync cursor and fetch everything, e.g. token expiry. */
  fullSync?: boolean;
}

/**
 * Synchronizes events from a single calendar.
 *
 * The flow:
 *   1. Load the connection and verify ownership.
 *   2. Find the target calendar record.
 *   3. Read the stored sync token (null on first sync).
 *   4. Call the provider to fetch events.
 *   5. Upsert each event into the database.
 *   6. Tombstone deleted events.
 *   7. Update the sync cursor.
 *
 * When the provider returns `tokenExpired: true`, the stored token is cleared
 * and the caller is expected to trigger a full re-sync.
 */
export const syncCalendar = async (
  ctx: SyncContext,
  input: SyncCalendarInput,
): Promise<SyncResult> => {
  const { db, logger, clock, provider } = ctx;
  const { userId, connectionId, calendarId, accessToken, fullSync } = input;

  // 1. Load the connection with ownership check.
  const connection = await db.calendarConnection.findFirst({
    where: { id: connectionId, userId },
  });

  if (!connection) {
    return { upserted: 0, deleted: 0, syncToken: null, tokenExpired: false };
  }

  if (connection.status !== 'CONNECTED') {
    return { upserted: 0, deleted: 0, syncToken: null, tokenExpired: false };
  }

  // 2. Find the target calendar.
  const calendar = await db.calendar.findFirst({
    where: { id: calendarId, connectionId, userId },
  });

  if (!calendar) {
    return { upserted: 0, deleted: 0, syncToken: null, tokenExpired: false };
  }

  // 3. Read stored sync token (a forced full sync ignores it).
  const syncToken = fullSync ? null : connection.syncCursor;

  // 4. Call the provider.
  const providerResult = await provider.listEvents(accessToken, {
    calendarId: calendar.externalId,
    syncToken,
  });

  // 5. Handle token expiry.
  if (providerResult.tokenExpired) {
    logger.warn(
      { connectionId, calendarId: calendar.externalId },
      'sync token expired; triggering full re-sync',
    );

    // Clear the cursor so the next sync does a full fetch.
    await db.calendarConnection.update({
      where: { id: connectionId },
      data: { syncCursor: null },
    });

    return {
      upserted: 0,
      deleted: 0,
      syncToken: null,
      tokenExpired: true,
    };
  }

  // 6. Process events.
  let upserted = 0;
  let deleted = 0;
  const syncedAt = clock.now();

  for (const event of providerResult.events) {
    if (event.status === 'CANCELLED') {
      // Tombstone: mark deleted, don't remove the row.
      const result = await db.calendarEvent.updateMany({
        where: {
          calendarId,
          externalId: event.externalId,
          userId,
          deletedAt: null,
        },
        data: {
          deletedAt: syncedAt,
          status: 'CANCELLED',
          syncState: 'SYNCED',
          lastSyncedAt: syncedAt,
        },
      });
      deleted += result.count;
    } else {
      // Upsert: idempotent on (calendarId, externalId).
      await db.calendarEvent.upsert({
        where: {
          calendarId_externalId: { calendarId, externalId: event.externalId },
        },
        create: {
          userId,
          calendarId,
          externalId: event.externalId,
          provider: 'GOOGLE',
          externalEtag: event.externalEtag ?? null,
          title: event.title,
          description: event.description ?? null,
          location: event.location ?? null,
          startAt: event.startAt,
          endAt: event.endAt,
          timeZone: event.timeZone,
          isAllDay: event.isAllDay,
          status: event.status,
          recurringEventId: event.recurringEventId ?? null,
          originalStartAt: event.originalStartAt ?? null,
          syncState: 'SYNCED',
          lastSyncedAt: syncedAt,
          deletedAt: null,
        },
        update: {
          externalEtag: event.externalEtag ?? null,
          title: event.title,
          description: event.description ?? null,
          location: event.location ?? null,
          startAt: event.startAt,
          endAt: event.endAt,
          timeZone: event.timeZone,
          isAllDay: event.isAllDay,
          status: event.status,
          recurringEventId: event.recurringEventId ?? null,
          originalStartAt: event.originalStartAt ?? null,
          syncState: 'SYNCED',
          lastSyncedAt: syncedAt,
          deletedAt: null,
        },
      });
      upserted += 1;
    }
  }

  // 7. Update sync cursor.
  await db.calendarConnection.update({
    where: { id: connectionId },
    data: {
      syncCursor: providerResult.syncToken,
      lastSyncedAt: syncedAt,
      lastErrorAt: null,
      lastErrorMessage: null,
      status: 'CONNECTED',
    },
  });

  // A sync that actually mutated the mirror is the loop's primary live "things
  // changed" signal (no task mutation surface exists yet). Emit it so the
  // autonomous review classifies the drift and replans affected days. Only a
  // genuine change is announced: a no-op incremental sync stays silent, which
  // is what keeps the review free of event storms.
  if (upserted + deleted > 0) {
    await audit.appendEvent(db, userId, {
      eventType: 'CALENDAR_CHANGED',
      aggregateType: 'CALENDAR_CONNECTION',
      aggregateId: connectionId,
      payload: {
        calendarId,
        externalCalendarId: calendar.externalId,
        upserted,
        deleted,
        changedCount: upserted + deleted,
      },
      occurredAt: syncedAt,
    });
  }

  logger.info(
    {
      connectionId,
      calendarId: calendar.externalId,
      upserted,
      deleted,
      hasToken: providerResult.syncToken != null,
    },
    'calendar sync completed',
  );

  return {
    upserted,
    deleted,
    syncToken: providerResult.syncToken,
    tokenExpired: false,
  };
};

/**
 * Discovers and mirrors the calendars for a connection that has none.
 *
 * Self-heal path: the web callback's initial discovery is best-effort, so a
 * transient Google failure can leave a `CONNECTED` connection with an empty
 * mirror — and the periodic sync has nothing to act on. This runs discovery
 * through the injected provider and upserts every result with the existing
 * calendar repository (idempotent on `(connectionId, externalId)`, preserving
 * the repository's default `isSelected` behavior).
 *
 * A failure is surfaced through the typed calendar-connection event log as a
 * `CALENDAR_SYNC_FAILED` entry (`reason: 'calendar-discovery-failed'`) and
 * rethrown, so the caller's retry classification (and the queue backoff on the
 * worker) owns recovery. A later successful pass clears the residual error
 * state exactly as a normal sync does.
 */
export const discoverCalendarsForConnection = async (
  ctx: SyncContext,
  input: { userId: string; connectionId: string; accessToken: string },
): Promise<number> => {
  const { db, logger, provider } = ctx;
  const { userId, connectionId, accessToken } = input;

  let discovered: ProviderCalendar[];
  try {
    discovered = await provider.listCalendars(accessToken);
  } catch (error) {
    await recordCalendarConnectionEvent(db, userId, {
      eventType: 'CALENDAR_SYNC_FAILED',
      connectionId,
      payload: {
        reason: 'calendar-discovery-failed',
        message: error instanceof Error ? error.message.slice(0, 500) : 'Calendar discovery failed',
      },
    });
    logger.warn(
      { connectionId, err: error },
      'calendar discovery failed; the next sync will retry it',
    );
    throw error;
  }

  for (const providerCalendar of discovered) {
    await calendarRepository.upsertCalendar(db, userId, {
      connectionId,
      externalId: providerCalendar.externalId,
      name: providerCalendar.name,
      timeZone: providerCalendar.timeZone,
      description: providerCalendar.description ?? null,
      isPrimary: providerCalendar.isPrimary,
      color: providerCalendar.color ?? null,
    });
  }

  return discovered.length;
};

/**
 * Synchronizes all selected calendars for a connection.
 *
 * Each calendar is synced independently: a failure on one does not prevent the
 * others from progressing.
 */
export const syncAllCalendars = async (
  ctx: SyncContext,
  input: SyncConnectionInput,
): Promise<{ calendarId: string; result: SyncResult }[]> => {
  const { db } = ctx;
  const { userId, connectionId, accessToken, fullSync } = input;

  // Self-heal: an existing `CONNECTED` connection whose callback discovery
  // failed has zero mirrored calendars, so the sync loop below would have
  // nothing to iterate. Discover now (this records a typed failure and rethrows
  // when discovery itself fails). Connections that already have mirrors —
  // selected or not — are untouched, preserving `isSelected` semantics.
  const mirrorCount = await db.calendar.count({
    where: { connectionId, userId },
  });

  if (mirrorCount === 0) {
    await discoverCalendarsForConnection(ctx, { userId, connectionId, accessToken });
  }

  const calendars = await db.calendar.findMany({
    where: { connectionId, userId, isSelected: true },
  });

  const results: { calendarId: string; result: SyncResult }[] = [];

  for (const calendar of calendars) {
    try {
      const result = await syncCalendar(ctx, {
        userId,
        connectionId,
        calendarId: calendar.id,
        accessToken,
        fullSync,
      });
      results.push({ calendarId: calendar.id, result });
    } catch (error) {
      ctx.logger.error(
        {
          connectionId,
          calendarId: calendar.id,
          err: error,
        },
        'calendar sync failed',
      );
      results.push({
        calendarId: calendar.id,
        result: {
          upserted: 0,
          deleted: 0,
          syncToken: null,
          tokenExpired: false,
        },
      });
    }
  }

  return results;
};
