import { vi, describe, expect, it, beforeEach } from 'vitest';

import type { Logger } from '@space/logger';
import { createLogger } from '@space/logger';
import { FixedClock } from '@space/time';
import { QUEUE_NAMES } from '@space/types';

import { createPgHandlers, type PgHandlersDeps } from '../handlers';
import type { PgJobContext } from '../runtime';

/**
 * The PG handler adapters: handler/class registration (including the
 * conditional calendar-sync family), malformed-payload dead-lettering, the
 * delivery final-attempt dead-letter hook, replan coalescing through the
 * jobs repository, and maintenance's durable-queue retention prune.
 */

const COALESCE = vi.fn<(db: unknown, input: unknown) => Promise<{ job: { id: string }; outcome: string }>>();
const ENQUEUE_DEDUPED = vi.fn<(db: unknown, input: unknown) => Promise<{ job: { id: string }; outcome: string }>>();
const PRUNE_TERMINAL = vi.fn<(db: unknown, input: unknown) => Promise<{ completed: number; terminal: number }>>();
const APPEND_EVENT = vi.fn<(db: unknown, userId: unknown, input: unknown) => Promise<{ id: string }>>();
const RUN_RETENTION = vi.fn<(db: unknown, window: unknown) => Promise<Record<string, { deleted: number; skipped: boolean }>>>();
const LEASE_ACQUIRE = vi.fn<(input: { connectionId: string; owner: string; ttlMs: number }) => Promise<boolean>>();
const LEASE_RELEASE = vi.fn<(input: { connectionId: string; owner: string }) => Promise<boolean>>();

vi.mock('@space/database', () => ({
  audit: { appendEvent: (db: unknown, userId: unknown, input: unknown) => APPEND_EVENT(db, userId, input) },
  jobs: {
    coalesceJob: (db: unknown, input: unknown) => COALESCE(db, input),
    enqueueDedupedJob: (db: unknown, input: unknown) => ENQUEUE_DEDUPED(db, input),
    pruneTerminalJobs: (db: unknown, input: unknown) => PRUNE_TERMINAL(db, input),
  },
  retention: {
    olderThanDays: (now: Date, days: number): Date =>
      new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
    runRetention: (db: unknown, window: unknown) => RUN_RETENTION(db, window),
  },
  syncLease: {
    acquireConnectionSyncLease: (_db: unknown, input: { connectionId: string; owner: string; ttlMs: number }) =>
      LEASE_ACQUIRE(input),
    releaseConnectionSyncLease: (_db: unknown, input: { connectionId: string; owner: string }) =>
      LEASE_RELEASE(input),
    getConnectionSyncLease: vi.fn(),
  },
}));

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
    resolveConnectionAccessToken: vi.fn().mockResolvedValue(undefined),
    syncAllCalendars: vi.fn(),
    syncCalendar: vi.fn(),
  };
});

vi.mock('@space/autonomy', () => ({
  createAutonomyService: vi.fn(),
}));

vi.mock('@space/notifications', () => {
  class RetryableDeliveryError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'RetryableDeliveryError';
      this.code = code;
    }
  }
  return {
    RetryableDeliveryError,
    runSweep: vi.fn().mockResolvedValue({
      daily: { created: 0 },
      reminders: { attempted: 0, dispatched: 0, duplicates: 0, skipped: 0 },
      outbox: { eventsRead: 0, eventsSkipped: 0, drafts: 0, created: 0, cursor: null },
      deliveries: { prepared: 0, inAppOnly: 0, providerUnconfigured: 0, staleWithoutLog: 0, reverted: 0 },
    }),
    deliverQueuedEmail: vi.fn(),
    finalizeFailedDelivery: vi.fn().mockResolvedValue(undefined),
  };
});

import { deliverQueuedEmail, finalizeFailedDelivery } from '@space/notifications';

const silentLogger = (): Logger =>
  createLogger({
    name: 'pg-handlers-test',
    level: 'fatal',
    destination: { write: () => undefined },
  });

const makeDeps = (calendar = true): PgHandlersDeps => ({
  db: {
    $executeRaw: vi.fn().mockResolvedValue(1),
    calendarConnection: { updateMany: vi.fn() },
  } as never,
  clock: new FixedClock(new Date('2026-09-13T12:00:00.000Z')),
  logger: silentLogger(),
  appUrl: 'https://space.test',
  emailProvider: { name: 'agentmail', send: vi.fn() },
  maxTasksPerPlan: 100,
  retention: {
    eventLogDays: 90,
    agentActionDays: 90,
    notificationDays: 90,
    emailLogDays: 90,
    sessionDays: 30,
    verificationDays: 7,
    calendarEventTombstoneDays: 90,
  },
  calendar: calendar
    ? { keyring: {} as never, google: { clientId: 'id', clientSecret: 'secret' } }
    : undefined,
});

const context = (overrides: Partial<PgJobContext> = {}): PgJobContext => ({
  jobId: 'job_1',
  queue: QUEUE_NAMES.planning,
  name: 'autonomous-replan',
  payload: {},
  attempts: 1,
  maxAttempts: 2,
  ...overrides,
});

beforeEach(() => {
  COALESCE.mockReset().mockResolvedValue({ job: { id: 'j' }, outcome: 'created' });
  ENQUEUE_DEDUPED.mockReset().mockResolvedValue({ job: { id: 'j' }, outcome: 'created' });
  PRUNE_TERMINAL.mockReset().mockResolvedValue({ completed: 0, terminal: 0 });
  APPEND_EVENT.mockReset().mockResolvedValue({ id: 'evt' });
  RUN_RETENTION.mockReset().mockResolvedValue({
    eventLogs: { deleted: 0, skipped: false },
    agentActions: { deleted: 0, skipped: false },
    notifications: { deleted: 0, skipped: false },
    emailLogs: { deleted: 0, skipped: false },
    sessions: { deleted: 0, skipped: false },
    verifications: { deleted: 0, skipped: false },
    calendarEventTombstones: { deleted: 0, skipped: false },
  });
  LEASE_ACQUIRE.mockReset().mockResolvedValue(true);
  LEASE_RELEASE.mockReset().mockResolvedValue(true);
  vi.mocked(deliverQueuedEmail).mockReset();
  vi.mocked(finalizeFailedDelivery).mockReset().mockResolvedValue(undefined);
});

describe('pg handlers', () => {
  it('registers all five families when calendar is configured, four otherwise', () => {
    const withCalendar = createPgHandlers(makeDeps(true));
    expect(Object.keys(withCalendar.handlers)).toHaveLength(5);
    expect(withCalendar.classes.map((c) => c.queue)).toContain(QUEUE_NAMES.calendarSync);
    expect(withCalendar.classes.find((c) => c.queue === QUEUE_NAMES.notifications)?.concurrency).toBe(3);

    const withoutCalendar = createPgHandlers(makeDeps(false));
    expect(Object.keys(withoutCalendar.handlers)).toHaveLength(4);
    expect(withoutCalendar.classes.map((c) => c.queue)).not.toContain(QUEUE_NAMES.calendarSync);
    return Promise.resolve();
  });

  it('dead-letters a planning job with a malformed payload instead of retrying it', async () => {
    const { handlers } = createPgHandlers(makeDeps());
    const handler = handlers[QUEUE_NAMES.planning]!;

    await expect(
      handler(context({ payload: { date: '2026-09-13' } })), // userId missing
    ).rejects.toMatchObject({ name: 'PermanentJobError' });
  });

  it('rejects a non-object payload outright', async () => {
    const { handlers } = createPgHandlers(makeDeps());

    await expect(
      handlers[QUEUE_NAMES.notifications]!(context({ queue: QUEUE_NAMES.notifications, name: 'sweep', payload: 'nope' })),
    ).rejects.toMatchObject({ name: 'PermanentJobError' });
  });

  it('coalesces replans by spaceId through the jobs repository', async () => {
    const { handlers } = createPgHandlers(makeDeps());
    const handler = handlers[QUEUE_NAMES.autonomyReview]!;
    const reviewDeps = { capture: null as null | ((request: unknown) => Promise<void>) };

    // Capture the enqueueReplan sink the autonomy service receives.
    const autonomy = await import('@space/autonomy');
    vi.mocked(autonomy.createAutonomyService).mockImplementation((deps) => {
      reviewDeps.capture = deps.enqueueReplan as (request: unknown) => Promise<void>;
      return { review: vi.fn().mockResolvedValue({}) };
    });

    await handler(context({ queue: QUEUE_NAMES.autonomyReview, name: 'review' }));
    await reviewDeps.capture!({
      userId: 'user_1',
      spaceId: 'space_1',
      date: new Date('2026-09-13T00:00:00.000Z'),
      planVersion: 7,
    });

    expect(COALESCE).toHaveBeenCalledTimes(1);
    const input = COALESCE.mock.calls[0]![1] as {
      dedupeKey: string;
      queue: string;
      name: string;
      maxAttempts: number;
      payload: Record<string, unknown>;
    };
    expect(input.dedupeKey).toBe('space:replan:space_1');
    expect(input.queue).toBe(QUEUE_NAMES.planning);
    expect(input.name).toBe('autonomous-replan');
    expect(input.maxAttempts).toBe(2);
    expect(input.payload.planVersion).toBe(7);
    expect(input.payload.trigger).toBe('autonomous');
  });

  it('runs the delivery dead-letter finalize when the final attempt fails', async () => {
    const { handlers } = createPgHandlers(makeDeps());
    vi.mocked(deliverQueuedEmail).mockRejectedValue(new Error('provider down'));

    const deliveryContext = context({
      queue: QUEUE_NAMES.notifications,
      name: 'delivery',
      payload: { kind: 'delivery', notificationId: 'n1', emailLogId: 'e1' },
      attempts: 3,
      maxAttempts: 3,
    });

    await expect(handlers[QUEUE_NAMES.notifications]!(deliveryContext)).rejects.toThrow('provider down');
    expect(finalizeFailedDelivery).toHaveBeenCalledTimes(1);
    expect(vi.mocked(finalizeFailedDelivery).mock.calls[0]![1]).toEqual({
      notificationId: 'n1',
      reason: 'provider down',
    });
  });

  it('does not run the dead-letter finalize while retry budget remains', async () => {
    const { handlers } = createPgHandlers(makeDeps());
    vi.mocked(deliverQueuedEmail).mockRejectedValue(new Error('provider down'));

    const retryableContext = context({
      queue: QUEUE_NAMES.notifications,
      name: 'delivery',
      payload: { kind: 'delivery', notificationId: 'n1', emailLogId: 'e1' },
      attempts: 1,
      maxAttempts: 3,
    });

    await expect(handlers[QUEUE_NAMES.notifications]!(retryableContext)).rejects.toThrow('provider down');
    expect(finalizeFailedDelivery).not.toHaveBeenCalled();
  });

  it('fans out sweep deliveries through deduped job enqueues', async () => {
    const { handlers } = createPgHandlers(makeDeps());
    const notifications = await import('@space/notifications');
    vi.mocked(notifications.runSweep).mockImplementationOnce(async (sweepDeps) => {
      await sweepDeps.enqueueDelivery({
        userId: 'user_1',
        notificationId: 'n1',
        emailLogId: 'e1',
        recipient: 'user_1@itest.local',
        template: 'daily-brief',
        data: {},
      });
      return {
        daily: { created: 0 },
        reminders: { attempted: 0, dispatched: 0, duplicates: 0, skipped: 0 },
        outbox: { eventsRead: 0, eventsSkipped: 0, drafts: 0, created: 0, cursor: null },
        deliveries: { prepared: 1, inAppOnly: 0, providerUnconfigured: 0, staleWithoutLog: 0, reverted: 0 },
      };
    });

    await handlers[QUEUE_NAMES.notifications]!(
      context({ queue: QUEUE_NAMES.notifications, name: 'sweep', payload: { kind: 'sweep' } }),
    );

    expect(ENQUEUE_DEDUPED).toHaveBeenCalledTimes(1);
    const enqueued = ENQUEUE_DEDUPED.mock.calls[0]![1] as {
      dedupeKey: string;
      maxAttempts: number;
    };
    expect(enqueued.dedupeKey).toBe('delivery-e1');
    expect(enqueued.maxAttempts).toBe(3);
  });

  it('prunes terminal background jobs after the retention pass', async () => {
    const { handlers } = createPgHandlers(makeDeps());

    await handlers[QUEUE_NAMES.maintenance]!(
      context({ queue: QUEUE_NAMES.maintenance, name: 'prune-retained-data', payload: { task: 'prune-retained-data' } }),
    );

    expect(PRUNE_TERMINAL).toHaveBeenCalledTimes(1);
  });

  it('executes the calendar handler with the database lease', async () => {
    const deps = makeDeps(true);
    const { handlers } = createPgHandlers(deps);

    await handlers[QUEUE_NAMES.calendarSync]!(
      context({
        queue: QUEUE_NAMES.calendarSync,
        name: 'auto-sync',
        payload: { userId: 'user_1', connectionId: 'conn_1', fullSync: false },
      }),
    );

    // Lease acquired through the sync-lease repository seam.
    expect(LEASE_ACQUIRE).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'conn_1' }),
    );
    expect(LEASE_RELEASE).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'conn_1' }),
    );
  });
});
