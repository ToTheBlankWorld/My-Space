import type { Database } from '@space/database';
import type { Keyring } from '@space/auth';
import type { Logger } from '@space/logger';
import type { Clock } from '@space/time';
import {
  CalendarAuthError,
  CalendarPermissionError,
  CalendarRateLimitError,
  CalendarSyncTokenExpiredError,
  CalendarTransientError,
  CalendarValidationError,
  GoogleCalendarProvider,
  recordCalendarConnectionEvent,
  resolveConnectionAccessToken,
  syncAllCalendars,
  syncCalendar,
  type GoogleClientCredentials,
  type SyncResult,
} from '@space/calendar';

/**
 * The calendar sync processor — one job synchronizes one user's calendar
 * connection. It runs exclusively on the PostgreSQL durable job queue; the
 * queue mechanics (claiming, retries, backoff, leases) belong to the runtime,
 * never to this file.
 *
 * Error classification:
 *   - Retryable (rate limit, transient provider failures): rethrown so the
 *     queue retries with backoff; the connection stays CONNECTED with
 *     `lastError*` recorded.
 *   - Non-retryable (expired/revoked credentials, a stale sync token, invalid
 *     provider data): the connection state or cursor is updated, the event is
 *     recorded, and the job returns success so no retry is spent.
 *
 * Mutual exclusion is provided by the injected `lease` — the PostgreSQL
 * connection lease (`createDatabaseConnectionSyncLock`): ~4-minute TTL, random
 * owner token, atomic acquire against the database clock, owner-checked
 * release, expired-lease takeover. Two concurrent syncs for one connection
 * would interleave read-modified-write on the sync cursor, so the second
 * acquirer abandons the job without a retry.
 */

export interface CalendarSyncJobPayload {
  /** The user who owns the connection. */
  userId: string;
  /** The CalendarConnection row id. */
  connectionId: string;
  /** Optional: sync a specific calendar. If absent, sync all selected. */
  calendarId?: string;
  /** Whether this is a full re-sync (ignores sync token). */
  fullSync?: boolean;
}

/** A mutual-exclusion seam (so the lease can be faked in tests). */
export interface SyncLock {
  acquire: () => Promise<boolean>;
  release: () => Promise<void>;
}

export interface CalendarSyncJobDeps {
  db: Database;
  clock: Clock;
  keyring: Keyring;
  google: GoogleClientCredentials;
  logger: Logger;
  /** Per-connection mutual exclusion (the PostgreSQL connection lease).
   * Mandatory: two concurrent syncs for one connection would interleave
   * read-modified-write on the sync cursor. */
  lease: SyncLock;
}

const setSyncError = async (
  db: Database,
  clock: Clock,
  input: { userId: string; connectionId: string; error: unknown; status: 'CONNECTED' | 'ERROR' },
): Promise<void> => {
  const { userId, connectionId, error, status } = input;
  const message = error instanceof Error ? error.message : 'Unknown calendar sync failure';

  await db.calendarConnection.updateMany({
    where: { id: connectionId, userId },
    data: {
      status,
      lastErrorAt: clock.now(),
      lastErrorMessage: message.slice(0, 500),
    },
  });
};

export interface CalendarSyncJobResult {
  success: true;
  skipped?: 'locked' | 'not-syncable' | 'stale-token';
  failed?: 'permanent' | 'validation';
  result?: SyncResult;
}

export const processCalendarSyncJob = async (
  { db, clock, keyring, google, logger, lease }: CalendarSyncJobDeps,
  payload: CalendarSyncJobPayload,
): Promise<CalendarSyncJobResult> => {
  const { userId, connectionId, calendarId, fullSync } = payload;
  const syncLogger = logger.child({
    userId,
    connectionId,
    calendarId: calendarId ?? null,
  });

  syncLogger.info({ fullSync: fullSync ?? false }, 'calendar sync job started');

  // 1. Concurrency lock: one sync in flight per connection.
  const acquired = await lease.acquire();
  if (!acquired) {
    syncLogger.info('sync skipped: another sync is running for this connection');
    return { success: true, skipped: 'locked' };
  }

  try {
    // 2. Resolve a fresh token (ownership + decrypt + refresh if stale).
    const resolved = await resolveConnectionAccessToken(
      { db, logger: syncLogger, clock, keyring, google },
      { userId, connectionId },
    );

    if (!resolved) {
      syncLogger.info('sync skipped: connection not connected or missing');
      return { success: true, skipped: 'not-syncable' };
    }

    // 3. Run the provider sync.
    const provider = new GoogleCalendarProvider();
    const ctx = { db, logger: syncLogger, clock, provider };

    const result: SyncResult = calendarId
      ? await syncCalendar(ctx, {
          userId,
          connectionId,
          calendarId,
          accessToken: resolved.accessToken,
          fullSync: fullSync ?? false,
        })
      : (
          await syncAllCalendars(ctx, {
            userId,
            connectionId,
            accessToken: resolved.accessToken,
            fullSync: fullSync ?? false,
          })
        ).reduce<SyncResult>(
          (acc, { result: r }) => ({
            upserted: acc.upserted + r.upserted,
            deleted: acc.deleted + r.deleted,
            syncToken: r.syncToken ?? acc.syncToken,
            tokenExpired: acc.tokenExpired || r.tokenExpired,
          }),
          { upserted: 0, deleted: 0, syncToken: null, tokenExpired: false },
        );

    // 4. Audit + clear any residual error state.
    await recordCalendarConnectionEvent(db, userId, {
      eventType: 'CALENDAR_SYNCED',
      connectionId,
      payload: {
        calendarId: calendarId ?? null,
        fullSync: fullSync ?? false,
        upserted: result.upserted,
        deleted: result.deleted,
      },
    });

    syncLogger.info(
      { upserted: result.upserted, deleted: result.deleted },
      'calendar sync job completed',
    );

    return { success: true, result };
  } catch (error) {
    // 5. Classify and record the failure.
    if (error instanceof CalendarAuthError || error instanceof CalendarPermissionError) {
      // Credentials can no longer be used. Stop retrying, surface ERROR.
      await setSyncError(db, clock, { userId, connectionId, error, status: 'ERROR' });
      await recordCalendarConnectionEvent(db, userId, {
        eventType: 'CALENDAR_SYNC_FAILED',
        connectionId,
        payload: {
          reason: error instanceof CalendarAuthError ? 'auth' : 'scope',
          message: error.message.slice(0, 500),
        },
      });
      syncLogger.error({ err: error }, 'calendar sync failed permanently');
      return { success: true, failed: 'permanent' };
    }

    if (error instanceof CalendarSyncTokenExpiredError) {
      // The incremental cursor is stale. Clear it so the next sync performs a
      // full fetch; nothing is broken enough to mark the ERROR state.
      await db.calendarConnection.updateMany({
        where: { id: connectionId, userId },
        data: { syncCursor: null },
      });
      await recordCalendarConnectionEvent(db, userId, {
        eventType: 'CALENDAR_SYNC_FAILED',
        connectionId,
        payload: { reason: 'expired-sync-token' },
      });
      syncLogger.warn({ err: error }, 'syncing from scratch after stale sync token');
      return { success: true, skipped: 'stale-token' };
    }

    if (error instanceof CalendarValidationError) {
      // Data from the provider is outside our schema; retrying won't help.
      await setSyncError(db, clock, { userId, connectionId, error, status: 'CONNECTED' });
      syncLogger.error({ err: error }, 'calendar sync rejected invalid event data');
      return { success: true, failed: 'validation' };
    }

    if (error instanceof CalendarRateLimitError || error instanceof CalendarTransientError) {
      // Transient: the job will be retried by the owning queue with backoff.
      await setSyncError(db, clock, { userId, connectionId, error, status: 'CONNECTED' });
      syncLogger.warn({ err: error }, 'calendar sync transient failure; will retry');
      throw error;
    }

    // Anything unexpected is retried too, but loudly.
    syncLogger.error({ err: error }, 'calendar sync unexpected failure; will retry');
    throw error;
  } finally {
    await lease.release();
    syncLogger.info('calendar sync lock released');
  }
};
