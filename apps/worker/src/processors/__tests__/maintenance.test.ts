import { vi, describe, expect, it, beforeEach } from 'vitest';

import type { Gauge } from '@space/metrics';
import type { retention as retentionTypes } from '@space/database';
import type { Logger } from '@space/logger';
import { createLogger } from '@space/logger';
import { FixedClock } from '@space/time';

import { processMaintenanceJob, type MaintenanceRetentionConfig } from '../maintenance';

/**
 * The maintenance processor with the retention repository mocked. Pins the
 * seven retention families, the window arithmetic, and the shared pruned-rows
 * gauge — behaviour both runtimes inherit.
 */

vi.mock('@space/database', () => ({
  retention: {
    olderThanDays: (now: Date, days: number): Date =>
      new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
    runRetention: vi.fn(),
  },
}));

import { retention } from '@space/database';

const silentLogger = (): Logger =>
  createLogger({
    name: 'maintenance-test',
    level: 'fatal',
    destination: { write: () => undefined },
  });

const EMPTY_COUNTS: retentionTypes.RetentionCounts = {
  eventLogs: { deleted: 1, skipped: false },
  agentActions: { deleted: 2, skipped: false },
  notifications: { deleted: 3, skipped: false },
  emailLogs: { deleted: 4, skipped: false },
  sessions: { deleted: 5, skipped: false },
  verifications: { deleted: 6, skipped: false },
  calendarEventTombstones: { deleted: 7, skipped: false },
};

const config: MaintenanceRetentionConfig = {
  eventLogDays: 90,
  agentActionDays: 90,
  notificationDays: 90,
  emailLogDays: 90,
  sessionDays: 30,
  verificationDays: 7,
  calendarEventTombstoneDays: 90,
};

beforeEach(() => {
  vi.mocked(retention.runRetention).mockReset().mockResolvedValue(EMPTY_COUNTS);
});

describe('maintenance processor', () => {
  it('runs the retention pass over every family and reports the counts', async () => {
    const db = {} as never;
    const clock = new FixedClock(new Date('2026-09-13T00:00:00.000Z'));

    const result = await processMaintenanceJob(
      { db, clock, logger: silentLogger(), retention: config },
      { task: 'prune-retained-data' },
    );

    expect(result.success).toBe(true);
    expect(retention.runRetention).toHaveBeenCalledTimes(1);
    const window = vi.mocked(retention.runRetention).mock.calls[0]![1];
    // 90 days before the fixed clock.
    expect(window.eventLogsOlderThan).toEqual(new Date('2026-06-15T00:00:00.000Z'));
    expect(window.expiredVerificationsOlderThan).toEqual(new Date('2026-09-06T00:00:00.000Z'));
  });

  it('reports pruned rows into the shared gauge', async () => {
    const prunedRows = { set: vi.fn() } as unknown as Gauge;
    const db = {} as never;
    const clock = new FixedClock(new Date('2026-09-13T00:00:00.000Z'));

    await processMaintenanceJob(
      { db, clock, logger: silentLogger(), retention: config, prunedRows },
      { task: 'prune-retained-data' },
    );

    expect(prunedRows.set).toHaveBeenCalledWith(1, { table: 'event_logs' });
    expect(prunedRows.set).toHaveBeenCalledWith(7, { table: 'calendar_events' });
  });

  it('propagates retention failures to the owning queue for retry', async () => {
    vi.mocked(retention.runRetention).mockRejectedValue(new Error('prune failed'));
    const db = {} as never;
    const clock = new FixedClock(new Date('2026-09-13T00:00:00.000Z'));

    await expect(
      processMaintenanceJob(
        { db, clock, logger: silentLogger(), retention: config },
        { task: 'prune-retained-data' },
      ),
    ).rejects.toThrow('prune failed');
  });
});
