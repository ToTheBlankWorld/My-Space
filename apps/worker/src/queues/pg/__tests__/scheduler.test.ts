import { vi, describe, expect, it, beforeEach } from 'vitest';

import type { Database } from '@space/database';
import type { Logger } from '@space/logger';
import { createLogger } from '@space/logger';
import { FixedClock } from '@space/time';
import { autoSyncScheduleKey, QUEUE_NAMES } from '@space/types';

import {
  createPgScheduleTicker,
  PG_SCHEDULE_KEYS,
  registerPgSchedules,
} from '../scheduler';

/**
 * Schedule registration and the ticker's claim-and-enqueue pass, against a
 * mocked jobs repository. The database-level
 * fleet-safety of schedule claiming is proven in the database integration
 * suite.
 */

const UPSERT = vi.fn<(input: { scheduleKey: string }) => Promise<{ id: string }>>();
const DELETE = vi.fn<(scheduleKey: string) => Promise<boolean>>();
const LIST = vi.fn<
  () => Promise<Array<{ scheduleKey: string; queue: string; name: string; payload: unknown }>>
>();
const CLAIM_DUE = vi.fn<
  (input: { limit: number }) => Promise<Array<{ id: string; scheduleKey: string; queue: string; name: string; payload: unknown }>>
>();
const ENQUEUE = vi.fn<(input: Record<string, unknown>) => Promise<{ id: string }>>();

vi.mock('@space/database', () => ({
  audit: { appendEvent: vi.fn() },
  jobs: {
    upsertJobSchedule: (_db: unknown, input: { scheduleKey: string }) => UPSERT(input),
    deleteJobSchedule: (_db: unknown, scheduleKey: string) => DELETE(scheduleKey),
    listJobSchedules: (_db: unknown) => LIST(),
    claimDueSchedules: (_db: unknown, input: { limit: number }) => CLAIM_DUE(input),
    enqueueJob: (_db: unknown, input: Record<string, unknown>) => ENQUEUE(input),
  },
  retention: { runRetention: vi.fn(), olderThanDays: vi.fn() },
  syncLease: {
    acquireConnectionSyncLease: vi.fn(),
    releaseConnectionSyncLease: vi.fn(),
    getConnectionSyncLease: vi.fn(),
  },
}));

const silentLogger = (): Logger =>
  createLogger({
    name: 'pg-scheduler-test',
    level: 'fatal',
    destination: { write: () => undefined },
  });

const clock = new FixedClock(new Date('2026-09-13T12:00:00.000Z'));

beforeEach(() => {
  UPSERT.mockReset().mockResolvedValue({ id: 's' });
  DELETE.mockReset().mockResolvedValue(true);
  LIST.mockReset().mockResolvedValue([]);
  CLAIM_DUE.mockReset().mockResolvedValue([]);
  ENQUEUE.mockReset().mockResolvedValue({ id: 'j' });
});

describe('schedule identity', () => {
  it('uses the canonical auto-sync key shared with the web producer', () => {
    // The web upserts `JobSchedule` rows under this key at connect time; the
    // worker ticks the same key. One identity, two writers, zero duplicates.
    expect(PG_SCHEDULE_KEYS.autoSync('conn_1')).toBe(autoSyncScheduleKey('conn_1'));
    expect(PG_SCHEDULE_KEYS.autoSync('conn_1')).toBe('auto-sync-conn_1');
  });
});

describe('registerPgSchedules', () => {
  it('registers the three fleet-wide schedules and per-connection auto-syncs', async () => {
    const findMany = vi.fn<() => Promise<Array<{ id: string; userId: string }>>>().mockResolvedValue([
      { id: 'conn_1', userId: 'user_1' },
    ]);
    const db = { calendarConnection: { findMany } } as unknown as Database;

    await registerPgSchedules({
      db,
      clock,
      logger: silentLogger(),
      intervals: {
        calendarSyncMinutes: 15,
        notificationSweepMinutes: 5,
        autonomyReviewMinutes: 5,
        maintenanceMinutes: 1440,
      },
      calendarConfigured: true,
    });

    const keys = UPSERT.mock.calls.map((call) => call[0]?.scheduleKey);
    expect(keys).toContain(PG_SCHEDULE_KEYS.notificationSweep);
    expect(keys).toContain(PG_SCHEDULE_KEYS.autonomyReview);
    expect(keys).toContain(PG_SCHEDULE_KEYS.maintenance);
    expect(keys).toContain(PG_SCHEDULE_KEYS.autoSync('conn_1'));

    const sweep = UPSERT.mock.calls.find(
      (call) => call[0]?.scheduleKey === PG_SCHEDULE_KEYS.notificationSweep,
    )![0] as unknown as Record<string, unknown>;
    expect(sweep.everySeconds).toBe(300);
    expect(sweep.queue).toBe(QUEUE_NAMES.notifications);
    expect(sweep.nextRunAt).toEqual(clock.now());
  });

  it('skips auto-sync registration when the calendar pipeline is unconfigured', async () => {
    const localFindMany = vi.fn<() => Promise<Array<{ id: string; userId: string }>>>();
    const db = {
      calendarConnection: { findMany: localFindMany },
    } as unknown as Database;

    await registerPgSchedules({
      db,
      clock,
      logger: silentLogger(),
      intervals: {
        calendarSyncMinutes: 15,
        notificationSweepMinutes: 5,
        autonomyReviewMinutes: 5,
        maintenanceMinutes: 1440,
      },
      calendarConfigured: false,
    });

    expect(localFindMany).not.toHaveBeenCalled();
    const keys = UPSERT.mock.calls.map((call) => call[0]?.scheduleKey);
    expect(keys.some((key) => key.startsWith('auto-sync-'))).toBe(false);
  });

  it('deletes auto-sync schedules whose connection is no longer connected', async () => {
    const findMany = vi.fn<() => Promise<Array<{ id: string; userId: string }>>>().mockResolvedValue([
      { id: 'conn_live', userId: 'user_1' },
    ]);
    const db = { calendarConnection: { findMany } } as unknown as Database;
    LIST.mockResolvedValue([
      { scheduleKey: 'auto-sync-conn_live', queue: QUEUE_NAMES.calendarSync, name: 'auto-sync', payload: { connectionId: 'conn_live' } },
      { scheduleKey: 'auto-sync-conn_dead', queue: QUEUE_NAMES.calendarSync, name: 'auto-sync', payload: { connectionId: 'conn_dead' } },
      { scheduleKey: 'space:maintenance', queue: QUEUE_NAMES.maintenance, name: 'prune-retained-data', payload: { task: 'prune-retained-data' } },
    ]);

    await registerPgSchedules({
      db,
      clock,
      logger: silentLogger(),
      intervals: {
        calendarSyncMinutes: 15,
        notificationSweepMinutes: 5,
        autonomyReviewMinutes: 5,
        maintenanceMinutes: 1440,
      },
      calendarConfigured: true,
    });

    expect(DELETE).toHaveBeenCalledTimes(1);
    expect(DELETE).toHaveBeenCalledWith('auto-sync-conn_dead');
  });
});

describe('pg schedule ticker', () => {
  it('materialises one due job per claimed schedule with the queue retry defaults', async () => {
    CLAIM_DUE.mockResolvedValue([
      { id: 's1', scheduleKey: 'auto-sync-conn_1', queue: QUEUE_NAMES.calendarSync, name: 'auto-sync', payload: { userId: 'u', connectionId: 'c', fullSync: false } },
      { id: 's2', scheduleKey: PG_SCHEDULE_KEYS.maintenance, queue: QUEUE_NAMES.maintenance, name: 'prune-retained-data', payload: { task: 'prune-retained-data' } },
    ]);

    const ticker = createPgScheduleTicker({ db: {} as never, clock, logger: silentLogger() });
    const fired = await ticker.tick();

    expect(fired).toBe(2);
    expect(ENQUEUE).toHaveBeenCalledTimes(2);
    const calendarJob = ENQUEUE.mock.calls[0]![0];
    expect(calendarJob.queue).toBe(QUEUE_NAMES.calendarSync);
    expect(calendarJob.maxAttempts).toBe(3);
    expect(calendarJob.backoffBaseMs).toBe(5_000);
    const maintenanceJob = ENQUEUE.mock.calls[1]![0];
    expect(maintenanceJob.maxAttempts).toBe(1);
    // Claimed schedule rows were already advanced by the atomic claim.
    expect(CLAIM_DUE).toHaveBeenCalledWith({ limit: 50 });
  });

  it('claims nothing when no schedule is due', async () => {
    CLAIM_DUE.mockResolvedValue([]);

    const ticker = createPgScheduleTicker({ db: {} as never, clock, logger: silentLogger() });
    expect(await ticker.tick()).toBe(0);
    expect(ENQUEUE).not.toHaveBeenCalled();
  });

  it('starts and stops without leaking timers', async () => {
    const ticker = createPgScheduleTicker({ db: {} as never, clock, logger: silentLogger(), intervalMs: 10 });
    ticker.start();
    await ticker.stop();
    await expect(ticker.stop()).resolves.toBeUndefined();
  });
});
