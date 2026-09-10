import { describe, expect, it, vi } from 'vitest';

import type { Database } from '@space/database';
import type { CalendarDate, TimeZone } from '@space/types';

import {
  buildPlanFingerprint,
  checkPlanStaleness,
  isPlanLikelyStale,
  STALENESS_THRESHOLD_MS,
  MAX_PLAN_AGE_MS,
} from './staleness';
import type { AffectedSpace } from './types';

const createMockDb = (overrides: Record<string, unknown> = {}): Database =>
  ({
    task: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    calendarEvent: { count: vi.fn().mockResolvedValue(0) },
    workingHoursBlock: { count: vi.fn().mockResolvedValue(0) },
    $transaction: vi.fn(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => fn({})),
    ...overrides,
  }) as unknown as Database;

const mockSpace = (overrides: Partial<AffectedSpace> = {}): AffectedSpace => ({
  userId: 'user-1',
  spaceId: 'space-1',
  date: '2025-06-15' as CalendarDate,
  timeZone: 'UTC' as TimeZone,
  planVersion: 1,
  optimizedAt: new Date('2025-06-15T00:00:00Z'),
  ...overrides,
});

describe('staleness constants', () => {
  it('STALENESS_THRESHOLD_MS is a non-negative number', () => {
    expect(typeof STALENESS_THRESHOLD_MS).toBe('number');
    expect(STALENESS_THRESHOLD_MS).toBeGreaterThanOrEqual(0);
  });

  it('MAX_PLAN_AGE_MS is a non-negative number', () => {
    expect(typeof MAX_PLAN_AGE_MS).toBe('number');
    expect(MAX_PLAN_AGE_MS).toBeGreaterThanOrEqual(0);
  });
});

describe('isPlanLikelyStale', () => {
  it('returns true when planVersion is 0', () => {
    const space = mockSpace({ planVersion: 0 });
    expect(isPlanLikelyStale(space, new Date())).toBe(true);
  });

  it('returns true when optimizedAt is null', () => {
    const space = mockSpace({ optimizedAt: null });
    expect(isPlanLikelyStale(space, new Date())).toBe(true);
  });

  it('returns false when the plan was optimized very recently', () => {
    const now = new Date('2025-06-15T00:00:10Z');
    const space = mockSpace({
      optimizedAt: new Date('2025-06-15T00:00:00Z'),
    });

    // 10s old is within the 15-minute staleness threshold → not stale.
    expect(isPlanLikelyStale(space, now)).toBe(false);
  });

  it('returns true when the plan is older than MAX_PLAN_AGE_MS', () => {
    // age is years, far beyond the 24-hour MAX_PLAN_AGE_MS.
    const now = new Date('2099-01-01T00:00:00Z');
    const space = mockSpace({
      optimizedAt: new Date('2025-06-15T00:00:00Z'),
    });

    expect(isPlanLikelyStale(space, now)).toBe(true);
  });

  it('returns true when age exceeds MAX_PLAN_AGE_MS', () => {
    // 5 days old exceeds the 24-hour MAX_PLAN_AGE_MS.
    const now = new Date('2025-06-20T00:00:00Z');
    const space = mockSpace({
      planVersion: 1,
      optimizedAt: new Date('2025-06-15T00:00:00Z'),
    });

    expect(isPlanLikelyStale(space, now)).toBe(true);
  });

  it('returns true when age exceeds threshold but is within MAX_PLAN_AGE_MS', () => {
    // 1 hour old exceeds the 15-minute threshold → stale, even though it is
    // well within the 24-hour MAX_PLAN_AGE_MS.
    const now = new Date('2025-06-15T01:00:00Z');
    const space = mockSpace({
      planVersion: 1,
      optimizedAt: new Date('2025-06-15T00:00:00Z'),
    });

    expect(isPlanLikelyStale(space, now)).toBe(true);
  });

  it('returns true when planVersion=0 and optimizedAt is set', () => {
    const space = mockSpace({ planVersion: 0, optimizedAt: new Date() });
    expect(isPlanLikelyStale(space, new Date())).toBe(true);
  });
});

describe('buildPlanFingerprint', () => {
  it('returns a fingerprint with correct structure', async () => {
    const db = createMockDb();
    const space = mockSpace();

    const fingerprint = await buildPlanFingerprint(db, space);

    expect(fingerprint.planVersion).toBe(1);
    expect(fingerprint.optimizedAtMs).toBe(new Date('2025-06-15T00:00:00Z').getTime());
    expect(fingerprint.openTaskCount).toBe(0);
    expect(fingerprint.calendarEventCount).toBe(0);
    expect(fingerprint.workingHoursCount).toBe(0);
    expect(fingerprint.taskStatusHash).toBe('');
  });

  it('returns correct counts from db', async () => {
    const db = createMockDb({
      task: {
        count: vi.fn().mockResolvedValue(5),
        findMany: vi.fn().mockResolvedValue([
          { id: 'a', status: 'PLANNED' },
          { id: 'b', status: 'INBOX' },
        ]),
      },
      calendarEvent: { count: vi.fn().mockResolvedValue(3) },
      workingHoursBlock: { count: vi.fn().mockResolvedValue(2) },
    });
    const space = mockSpace();

    const fingerprint = await buildPlanFingerprint(db, space);

    expect(fingerprint.openTaskCount).toBe(5);
    expect(fingerprint.calendarEventCount).toBe(3);
    expect(fingerprint.workingHoursCount).toBe(2);
    expect(fingerprint.taskStatusHash).toBe('a:PLANNED|b:INBOX');
  });
});

describe('checkPlanStaleness', () => {
  it('returns stale:true when planVersion is 0', () => {
    const db = createMockDb();
    const space = mockSpace({ planVersion: 0 });

    const result = checkPlanStaleness(db, space, new Date('2025-06-15T12:00:00Z'));

    expect(result.stale).toBe(true);
    expect(result.reason).toContain('never been planned');
  });

  it('returns stale:false when plan is very recent', () => {
    const db = createMockDb();
    const space = mockSpace({
      planVersion: 1,
      optimizedAt: new Date('2025-06-15T12:00:00Z'),
    });

    // 1 minute old is within the 15-minute threshold → fresh.
    const result = checkPlanStaleness(db, space, new Date('2025-06-15T12:01:00Z'));

    expect(result.stale).toBe(false);
  });

  it('returns stale:true when plan exceeds STALENESS_THRESHOLD_MS', () => {
    const db = createMockDb();
    const space = mockSpace({
      planVersion: 1,
      optimizedAt: new Date('2025-06-15T12:00:00Z'),
    });

    // 1 hour old exceeds the 15-minute threshold → stale.
    const result = checkPlanStaleness(db, space, new Date('2025-06-15T13:00:00Z'));

    expect(result.stale).toBe(true);
    expect(result.reason).toContain('staleness threshold');
  });

  it('returns stale:true when plan exceeds MAX_PLAN_AGE_MS', () => {
    const db = createMockDb();
    const space = mockSpace({
      planVersion: 1,
      optimizedAt: new Date('2025-06-15T12:00:00Z'),
    });

    // 2 days old exceeds the 24-hour MAX_PLAN_AGE_MS.
    const result = checkPlanStaleness(db, space, new Date('2025-06-17T12:00:00Z'));

    expect(result.stale).toBe(true);
    expect(result.reason).toContain('hours');
  });

  it('returns stale:true when optimizedAt is null', () => {
    const db = createMockDb();
    const space = mockSpace({
      planVersion: 1,
      optimizedAt: null,
    });

    const result = checkPlanStaleness(db, space, new Date('2025-06-15T12:00:00Z'));

    // No recorded optimization → no way to prove freshness → conservative stale.
    expect(result.stale).toBe(true);
  });
});
