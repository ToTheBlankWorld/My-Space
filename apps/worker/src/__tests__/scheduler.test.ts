import { createLogger, type Logger } from '@space/logger';
import { describe, expect, it } from 'vitest';

import type { QueueDefinitions } from '../queues';
import {
  scheduleAutoSyncs,
  scheduleAutonomyReview,
  scheduleMaintenance,
  scheduleNotificationSweep,
} from '../scheduler';

/**
 * Regression tests for the BullMQ 5.81 custom job id rule.
 *
 * Custom job ids must be colon-free (or carry exactly three colon-separated
 * segments, the legacy repeatable form). `auto-sync:${connectionId}` was a
 * two-segment colon id and was rejected with "Custom Id cannot contain :".
 */
const silentLogger = (): Logger =>
  createLogger({
    name: 'scheduler-test',
    level: 'fatal',
    destination: { write: () => undefined },
  });

interface RecordedCall {
  queue: keyof QueueDefinitions;
  name: string;
  jobId?: string;
  repeat?: unknown;
}

const captureQueues = (records: RecordedCall[]): QueueDefinitions => {
  const record =
    (queue: keyof QueueDefinitions) =>
    (name: string, _data: unknown, opts?: { jobId?: string; repeat?: unknown }): Promise<void> => {
      records.push({ queue, name, jobId: opts?.jobId, repeat: opts?.repeat });
      return Promise.resolve();
    };

  return {
    calendarSync: { add: record('calendarSync') },
    calendarRefresh: { add: record('calendarRefresh') },
    maintenance: { add: record('maintenance') },
    planning: { add: record('planning') },
    notifications: { add: record('notifications') },
    autonomyReview: { add: record('autonomyReview') },
  } as unknown as QueueDefinitions;
};

describe('scheduling job ids (BullMQ 5.81 validation)', () => {
  it('schedules auto-syncs for CONNECTED connections with a colon-free, deterministic job id', async () => {
    const records: RecordedCall[] = [];
    const db = {
      calendarConnection: {
        findMany: () => Promise.resolve([{ id: 'conn_abc', userId: 'user_abc' }]),
      },
    } as never;

    await scheduleAutoSyncs({
      db,
      queues: captureQueues(records),
      intervalMinutes: 15,
      logger: silentLogger(),
    });

    expect(records).toHaveLength(1);
    const call = records[0];
    expect(call).toBeDefined();
    expect(call?.queue).toBe('calendarSync');
    expect(call?.name).toBe('auto-sync');
    expect(call?.jobId).toBe('auto-sync-conn_abc');
    expect(call?.repeat).toEqual({ every: 900_000 });
    expect(call?.jobId).not.toMatch(/:/);
  });

  it('does not throw when a CONNECTED calendar connection is present', async () => {
    const db = {
      calendarConnection: {
        findMany: () =>
          Promise.resolve([
            { id: 'conn_001', userId: 'user_001' },
            { id: 'conn_002', userId: 'user_002' },
          ]),
      },
    } as never;

    await expect(
      scheduleAutoSyncs({
        db,
        queues: captureQueues([]),
        intervalMinutes: 15,
        logger: silentLogger(),
      }),
    ).resolves.toBeUndefined();
  });

  it('keeps the repeatable job ids unchanged', async () => {
    const records: RecordedCall[] = [];
    const queues = captureQueues(records);
    const logger = silentLogger();

    await scheduleNotificationSweep({ queues, intervalMinutes: 5, logger });
    await scheduleAutonomyReview({ queues, intervalMinutes: 5, logger });
    await scheduleMaintenance({ queues, intervalMinutes: 1440, logger });

    // These repeatable ids carry a ':' yet work in production: the repeatable
    // path never runs Job.validateOptions (iterations get an auto-generated
    // id), so they are intentionally left exactly as-is.
    expect(records.map((call) => call.jobId)).toEqual([
      'space:notification-sweep',
      'space:autonomy-review',
      'space:maintenance',
    ]);
  });

  it('schedules each repeatable job with its repeat options intact', async () => {
    const records: RecordedCall[] = [];
    const queues = captureQueues(records);
    const logger = silentLogger();

    await scheduleNotificationSweep({ queues, intervalMinutes: 5, logger });

    const call = records[0];
    expect(call).toBeDefined();
    expect(call?.queue).toBe('notifications');
    expect(call?.name).toBe('sweep');
    expect(call?.jobId).toBe('space:notification-sweep');
    expect(call?.repeat).toEqual({ every: 300_000 });
  });
});
