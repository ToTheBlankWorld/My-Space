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
import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import type { CalendarSyncJobPayload } from '.';
import { createConnectionSyncLock } from './sync-lock';

/**
 * Calendar sync worker processor.
 *
 * Each job synchronizes one user's calendar connection. The processor holds a
 * per-connection Redis lock (two processes must never sync the same connection
 * concurrently), resolves a fresh decrypted access token, runs the provider
 * sync, and records the outcome in the audit log.
 *
 * Retry classification:
 *   - Retryable (rate limit, provisioning growing pains, transient provider
 *     failures): the connection stays `CONNECTED` with `lastError*` recorded,
 *     and the error is re-thrown so BullMQ retries with backoff.
 *   - Non-retryable (expired/revoked credentials, a full resync already
 *     handled): the connection moves to `ERROR`, the event is recorded as
 *     `CALENDAR_SYNC_FAILED`, and the job returns success so no job is retried.
 */
export interface CalendarSyncWorkerDeps {
  logger: Logger;
  connection: Redis;
  db: Database;
  clock: Clock;
  keyring: Keyring;
  google: GoogleClientCredentials;
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

export const createCalendarSyncWorker = ({
  db,
  clock,
  keyring,
  google,
  logger,
  connection,
}: CalendarSyncWorkerDeps): Worker => {
  return new Worker<CalendarSyncJobPayload>(
    'space:calendar-sync',
    async (job: Job<CalendarSyncJobPayload>) => {
      const { userId, connectionId, calendarId, fullSync } = job.data;
      const syncLogger = logger.child({
        jobId: job.id,
        userId,
        connectionId,
        calendarId: calendarId ?? null,
      });

      syncLogger.info({ fullSync: fullSync ?? false }, 'calendar sync job started');

      // 1. Concurrency lock: one sync in flight per connection.
      const lock = createConnectionSyncLock(connection, connectionId);
      const acquired = await lock.acquire();
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
        const ctx = {
          db,
          logger: syncLogger,
          clock,
          provider,
        };

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
          // The incremental cursor is stale. Clear it so the next sync performs
          // a full fetch; nothing is broken enough to mark the ERROR state.
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
          // Transient: the job will be retried by BullMQ with backoff.
          await setSyncError(db, clock, { userId, connectionId, error, status: 'CONNECTED' });
          syncLogger.warn({ err: error }, 'calendar sync transient failure; will retry');
          throw error;
        }

        // Anything unexpected is retried too, but loudly.
        syncLogger.error({ err: error }, 'calendar sync unexpected failure; will retry');
        throw error;
      } finally {
        await lock.release();
        syncLogger.info('calendar sync lock released');
      }
    },
    {
      connection,
      concurrency: 2,
      limiter: {
        max: 10,
        duration: 60_000,
      },
    },
  );
};
