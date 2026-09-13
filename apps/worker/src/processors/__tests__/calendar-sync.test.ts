import { vi, describe, expect, it, beforeEach } from 'vitest';

import type { Database } from '@space/database';
import type { Logger } from '@space/logger';
import { createLogger } from '@space/logger';
import { FixedClock } from '@space/time';
import {
  CalendarAuthError,
  CalendarRateLimitError,
  CalendarSyncTokenExpiredError,
  CalendarTransientError,
  CalendarValidationError,
  type SyncResult,
} from '@space/calendar';

import { processCalendarSyncJob, type SyncLock } from '../calendar-sync';

/**
 * The calendar sync processor, with the Google provider surface mocked. These
 * tests pin the semantics the PG handler inherits: lease-gated execution, the
 * transient vs permanent error classification, and lease release on every
 * path.
 */

vi.mock('@space/calendar', () => {
  const makeError = (name: string): new (message: string) => Error =>
    class extends Error {
      constructor(message: string) {
        super(message);
        this.name = name;
      }
    };
  return {
    CalendarAuthError: makeError('CalendarAuthError'),
    CalendarPermissionError: makeError('CalendarPermissionError'),
    CalendarRateLimitError: makeError('CalendarRateLimitError'),
    CalendarSyncTokenExpiredError: makeError('CalendarSyncTokenExpiredError'),
    CalendarTransientError: makeError('CalendarTransientError'),
    CalendarValidationError: makeError('CalendarValidationError'),
    GoogleCalendarProvider: class {},
    recordCalendarConnectionEvent: vi.fn(),
    resolveConnectionAccessToken: vi.fn(),
    syncAllCalendars: vi.fn(),
    syncCalendar: vi.fn(),
  };
});

import {
  recordCalendarConnectionEvent,
  resolveConnectionAccessToken,
  syncAllCalendars,
} from '@space/calendar';

const silentLogger = (): Logger =>
  createLogger({
    name: 'calendar-sync-test',
    level: 'fatal',
    destination: { write: () => undefined },
  });

const SYNC_RESULT: SyncResult = {
  upserted: 3,
  deleted: 1,
  syncToken: 'token-2',
  tokenExpired: false,
};

const makeDeps = (lease: SyncLock) => {
  const db = {
    calendarConnection: {
      updateMany: vi.fn<(input: {
        where: { id: string; userId: string };
        data: { status?: string; syncCursor?: string | null; lastErrorAt?: unknown; lastErrorMessage?: unknown };
      }) => Promise<{ count: number }>>(),
    },
  };
  db.calendarConnection.updateMany.mockResolvedValue({ count: 1 });

  return {
    deps: {
      db: db as unknown as Database,
      clock: new FixedClock(new Date('2026-09-13T12:00:00.000Z')),
      keyring: {} as never,
      google: { clientId: 'id', clientSecret: 'secret' },
      logger: silentLogger(),
      lease,
    } satisfies Parameters<typeof processCalendarSyncJob>[0],
    updateMany: db.calendarConnection.updateMany,
  };
};

const payload = { userId: 'user_1', connectionId: 'conn_1', fullSync: false };

const fakeLock = (
  acquireResult: boolean,
): SyncLock & { acquire: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } => ({
  acquire: vi.fn<(this: void) => Promise<boolean>>().mockResolvedValue(acquireResult),
  release: vi.fn<(this: void) => Promise<void>>().mockResolvedValue(undefined),
});

type UpdateManyMock = ReturnType<typeof makeDeps>['updateMany'];

const lastUpdateData = (
  updateMany: UpdateManyMock,
): { status?: string; syncCursor?: string | null } =>
  updateMany.mock.calls.at(-1)?.[0]?.data ?? {};

beforeEach(() => {
  vi.mocked(resolveConnectionAccessToken).mockReset();
  vi.mocked(syncAllCalendars).mockReset();
  vi.mocked(recordCalendarConnectionEvent).mockReset();
  vi.mocked(recordCalendarConnectionEvent).mockResolvedValue(undefined);
});

describe('calendar sync processor', () => {
  it('skips without resolving a token or syncing when the lease is held elsewhere', async () => {
    const lease = fakeLock(false);
    const { deps } = makeDeps(lease);

    const result = await processCalendarSyncJob(deps, payload);

    expect(result).toEqual({ success: true, skipped: 'locked' });
    expect(lease.acquire).toHaveBeenCalledTimes(1);
    expect(resolveConnectionAccessToken).not.toHaveBeenCalled();
    expect(syncAllCalendars).not.toHaveBeenCalled();
    expect(lease.release).not.toHaveBeenCalled();
  });

  it('runs the sync, records the audit event, and releases the lease', async () => {
    const lease = fakeLock(true);
    const { deps } = makeDeps(lease);
    vi.mocked(resolveConnectionAccessToken).mockResolvedValue({ accessToken: 'tok' });
    vi.mocked(syncAllCalendars).mockResolvedValue([{ calendarId: 'cal_1', result: SYNC_RESULT }]);

    const result = await processCalendarSyncJob(deps, payload);

    expect(result).toMatchObject({ success: true, result: SYNC_RESULT });
    expect(syncAllCalendars).toHaveBeenCalledTimes(1);
    expect(recordCalendarConnectionEvent).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('skips cleanly when the connection is not syncable', async () => {
    const lease = fakeLock(true);
    const { deps } = makeDeps(lease);
    vi.mocked(resolveConnectionAccessToken).mockResolvedValue(null);

    const result = await processCalendarSyncJob(deps, payload);

    expect(result).toEqual({ success: true, skipped: 'not-syncable' });
    expect(syncAllCalendars).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('rethrows transient failures so the owning queue retries, after releasing the lease', async () => {
    const lease = fakeLock(true);
    const { deps, updateMany } = makeDeps(lease);
    vi.mocked(resolveConnectionAccessToken).mockResolvedValue({ accessToken: 'tok' });
    vi.mocked(syncAllCalendars).mockRejectedValue(new CalendarTransientError('boom'));

    await expect(processCalendarSyncJob(deps, payload)).rejects.toBeInstanceOf(CalendarTransientError);
    expect(lastUpdateData(updateMany).status).toBe('CONNECTED');
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('rethrows rate-limit failures for backoff', async () => {
    const lease = fakeLock(true);
    const { deps } = makeDeps(lease);
    vi.mocked(resolveConnectionAccessToken).mockResolvedValue({ accessToken: 'tok' });
    vi.mocked(syncAllCalendars).mockRejectedValue(new CalendarRateLimitError('slow down'));

    await expect(processCalendarSyncJob(deps, payload)).rejects.toBeInstanceOf(CalendarRateLimitError);
  });

  it('records permanent auth failures, marks the connection ERROR, and does not retry', async () => {
    const lease = fakeLock(true);
    const { deps, updateMany } = makeDeps(lease);
    vi.mocked(resolveConnectionAccessToken).mockResolvedValue({ accessToken: 'tok' });
    vi.mocked(syncAllCalendars).mockRejectedValue(new CalendarAuthError('revoked'));

    const result = await processCalendarSyncJob(deps, payload);

    expect(result).toEqual({ success: true, failed: 'permanent' });
    expect(lastUpdateData(updateMany).status).toBe('ERROR');
    expect(recordCalendarConnectionEvent).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('clears the sync cursor on a stale token and returns without retry', async () => {
    const lease = fakeLock(true);
    const { deps, updateMany } = makeDeps(lease);
    vi.mocked(resolveConnectionAccessToken).mockResolvedValue({ accessToken: 'tok' });
    vi.mocked(syncAllCalendars).mockRejectedValue(new CalendarSyncTokenExpiredError('stale'));

    const result = await processCalendarSyncJob(deps, payload);

    expect(result).toEqual({ success: true, skipped: 'stale-token' });
    expect(lastUpdateData(updateMany).syncCursor).toBeNull();
  });

  it('treats invalid provider data as a permanent validation failure', async () => {
    const lease = fakeLock(true);
    const { deps, updateMany } = makeDeps(lease);
    vi.mocked(resolveConnectionAccessToken).mockResolvedValue({ accessToken: 'tok' });
    vi.mocked(syncAllCalendars).mockRejectedValue(new CalendarValidationError('bad event'));

    const result = await processCalendarSyncJob(deps, payload);

    expect(result).toEqual({ success: true, failed: 'validation' });
    expect(lastUpdateData(updateMany).status).toBe('CONNECTED');
  });
});
