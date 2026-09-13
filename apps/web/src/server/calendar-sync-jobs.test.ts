import { vi, describe, expect, it, beforeEach } from 'vitest';

import type { Database } from '@space/database';

import {
  calendarSyncJobPayloadSchema,
  enqueueCalendarSync,
  scheduleCalendarAutoSync,
} from './calendar-sync-jobs';

/**
 * The web-side PostgreSQL producer: manual syncs become deduplicated
 * `BackgroundJob` rows, auto-sync registrations become `JobSchedule` rows.
 * The repository's dedupe/rearm/schedule mechanics are proven against real
 * PostgreSQL in the database integration suite; here we pin what the web
 * sends: validated payloads, the shared identity keys, the re-arm semantics,
 * and the retry defaults.
 */

const ENQUEUE_DEDUPED = vi.fn<
  (db: unknown, input: unknown, options: unknown) => Promise<{ job: { id: string }; outcome: string }>
>();
const UPSERT_SCHEDULE = vi.fn<(db: unknown, input: unknown) => Promise<{ id: string }>>();

vi.mock('@space/database', () => ({
  jobs: {
    enqueueDedupedJob: (db: unknown, input: unknown, options: unknown) =>
      ENQUEUE_DEDUPED(db, input, options),
    upsertJobSchedule: (db: unknown, input: unknown) => UPSERT_SCHEDULE(db, input),
  },
}));

const db = { marker: 'web-test-db' } as unknown as Database;
const clock = { now: () => new Date('2026-09-13T12:00:00.000Z') };

beforeEach(() => {
  ENQUEUE_DEDUPED.mockReset().mockResolvedValue({ job: { id: 'job_1' }, outcome: 'created' });
  UPSERT_SCHEDULE.mockReset().mockResolvedValue({ id: 'sched_1' });
});

describe('enqueueCalendarSync', () => {
  it('creates a durable job for a manual full-connection sync', async () => {
    await enqueueCalendarSync(db, { userId: 'user_1', connectionId: 'conn_1', fullSync: true }, clock);

    expect(ENQUEUE_DEDUPED).toHaveBeenCalledTimes(1);
    const [calledDb, input, options] = ENQUEUE_DEDUPED.mock.calls[0]! as [
      unknown,
      {
        queue: string;
        name: string;
        payload: { userId: string; connectionId: string; fullSync: boolean };
        runAt: Date;
        dedupeKey: string;
        maxAttempts: number;
        backoffBaseMs: number;
      },
      unknown,
    ];
    expect(calledDb).toBe(db);
    expect(input.queue).toBe('calendar-sync');
    expect(input.name).toBe('manual-sync');
    expect(input.payload).toEqual({ userId: 'user_1', connectionId: 'conn_1', fullSync: true });
    expect(input.runAt).toEqual(clock.now());
    expect(input.dedupeKey).toBe('manual:conn_1:all');
    // Retry budget and first backoff step.
    expect(input.maxAttempts).toBe(3);
    expect(input.backoffBaseMs).toBe(5_000);
    // A completed manual sync must be requestable again.
    expect(options).toEqual({ rearm: true });
  });

  it('creates a job for a single-calendar sync with the target in the identity', async () => {
    await enqueueCalendarSync(
      db,
      { userId: 'user_1', connectionId: 'conn_1', calendarId: 'cal_9' },
      clock,
    );

    const input = ENQUEUE_DEDUPED.mock.calls[0]![1] as {
      payload: { calendarId?: string; fullSync: boolean };
      dedupeKey: string;
    };
    expect(input.payload.calendarId).toBe('cal_9');
    expect(input.payload.fullSync).toBe(false);
    expect(input.dedupeKey).toBe('manual:conn_1:cal_9');
  });

  it('gives repeated identical requests the same dedupe identity', async () => {
    const request = { userId: 'user_1', connectionId: 'conn_1' } as const;
    await enqueueCalendarSync(db, request, clock);
    await enqueueCalendarSync(db, request, clock);

    const first = ENQUEUE_DEDUPED.mock.calls[0]![1] as { dedupeKey: string };
    const second = ENQUEUE_DEDUPED.mock.calls[1]![1] as { dedupeKey: string };
    expect(first.dedupeKey).toBe(second.dedupeKey);
    // The repository's insert-if-absent + rearm semantics absorb the duplicate
    // while pending/running and re-arm once terminal (integration-proven).
  });

  it('refuses malformed payloads before anything reaches the queue', async () => {
    await expect(
      enqueueCalendarSync(db, { userId: 'user_1', connectionId: '' }, clock),
    ).rejects.toThrow();
    await expect(
      enqueueCalendarSync(db, { userId: 'user_1', connectionId: 'conn_1', calendarId: '' }, clock),
    ).rejects.toThrow();
    await expect(
      // @ts-expect-error — deliberately invalid input type
      enqueueCalendarSync(db, { userId: 'user_1', connectionId: 'conn_1', fullSync: 'yes' }, clock),
    ).rejects.toThrow();
    expect(ENQUEUE_DEDUPED).not.toHaveBeenCalled();
  });

  it('validates the exact payload shape', () => {
    const valid = calendarSyncJobPayloadSchema.safeParse({
      userId: 'user_1',
      connectionId: 'conn_1',
      fullSync: false,
    });
    expect(valid.success).toBe(true);

    const invalid = calendarSyncJobPayloadSchema.safeParse({ userId: 'user_1' });
    expect(invalid.success).toBe(false);
  });
});

describe('scheduleCalendarAutoSync', () => {
  it('upserts the shared auto-sync schedule with the deployment cadence', async () => {
    await scheduleCalendarAutoSync(db, { userId: 'user_1', connectionId: 'conn_1' }, clock, 15);

    expect(UPSERT_SCHEDULE).toHaveBeenCalledTimes(1);
    const [calledDb, input] = UPSERT_SCHEDULE.mock.calls[0]! as [
      unknown,
      {
        scheduleKey: string;
        queue: string;
        name: string;
        payload: { userId: string; connectionId: string; fullSync: boolean };
        everySeconds: number;
        nextRunAt: Date;
      },
    ];
    expect(calledDb).toBe(db);
    expect(input.scheduleKey).toBe('auto-sync-conn_1');
    expect(input.queue).toBe('calendar-sync');
    expect(input.name).toBe('auto-sync');
    expect(input.payload).toEqual({
      userId: 'user_1',
      connectionId: 'conn_1',
      fullSync: false,
    });
    expect(input.everySeconds).toBe(900);
    expect(input.nextRunAt).toEqual(clock.now());
  });

  it('honours a configured interval and floors it at one minute', async () => {
    await scheduleCalendarAutoSync(db, { userId: 'u', connectionId: 'c' }, clock, 5);
    expect((UPSERT_SCHEDULE.mock.calls[0]![1] as { everySeconds: number }).everySeconds).toBe(300);

    await scheduleCalendarAutoSync(db, { userId: 'u', connectionId: 'c' }, clock, 0);
    expect((UPSERT_SCHEDULE.mock.calls[1]![1] as { everySeconds: number }).everySeconds).toBe(60);
  });
});
