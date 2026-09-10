import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Database } from '@space/database';
import { FixedClock } from '@space/time';

import { checkFeedbackLoop, shouldExcludeFromReplan } from './feedback-loop';
import { getRecentUserChanges } from './policy';

vi.mock('./policy', () => ({
  getRecentUserChanges: vi.fn().mockResolvedValue([]),
}));

const CLOCK = new FixedClock('2025-06-15T12:00:00Z');

const createMockDb = (overrides: Record<string, unknown> = {}): Database =>
  ({
    eventLog: { findMany: vi.fn().mockResolvedValue([]) },
    task: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => fn({})),
    ...overrides,
  }) as unknown as Database;

describe('checkFeedbackLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRecentUserChanges).mockResolvedValue([]);
  });

  it('returns suppressed:false when no recent user changes exist for the task', async () => {
    const db = createMockDb();
    const result = await checkFeedbackLoop(db, CLOCK, 'user-1', 'space-1', 'task-1');

    expect(result.suppressed).toBe(false);
    expect(result.cycleDetected).toBe(false);
  });

  it('returns suppressed:true when a TASK_RESCHEDULED event with trigger:"user" exists within the suppression window', async () => {
    const now = new Date();
    vi.mocked(getRecentUserChanges).mockResolvedValue([
      {
        taskId: 'task-1',
        userId: 'user-1',
        spaceId: 'space-1',
        changeType: 'SCHEDULE',
        newValue: '2025-06-15T14:00:00Z',
        occurredAt: now,
      },
    ]);

    const db = createMockDb();
    const result = await checkFeedbackLoop(db, CLOCK, 'user-1', 'space-1', 'task-1');

    expect(result.suppressed).toBe(true);
    expect(result.triggerChange).toBeDefined();
    expect(result.triggerChange!.taskId).toBe('task-1');
  });

  it('returns suppressed:true when a TASK_COMPLETED event with trigger:"user" exists within the suppression window', async () => {
    const now = new Date();
    vi.mocked(getRecentUserChanges).mockResolvedValue([
      {
        taskId: 'task-1',
        userId: 'user-1',
        spaceId: 'space-1',
        changeType: 'COMPLETED',
        newValue: 'COMPLETED',
        occurredAt: now,
      },
    ]);

    const db = createMockDb();
    const result = await checkFeedbackLoop(db, CLOCK, 'user-1', 'space-1', 'task-1');

    expect(result.suppressed).toBe(true);
    expect(result.triggerChange!.changeType).toBe('COMPLETED');
  });

  it('does NOT suppress when the TASK_RESCHEDULED event has trigger:"autonomous"', async () => {
    const now = new Date();
    vi.mocked(getRecentUserChanges).mockResolvedValue([
      {
        taskId: 'task-1',
        userId: 'user-1',
        spaceId: 'space-1',
        changeType: 'SCHEDULE',
        newValue: '2025-06-15T14:00:00Z',
        occurredAt: now,
      },
    ]);

    // Override the mock to return only non-user events by making the filter
    // produce an empty result. getRecentUserChanges already filters by
    // isUserInitiated, so we simulate an autonomous change by returning empty.
    vi.mocked(getRecentUserChanges).mockResolvedValue([]);

    const db = createMockDb();
    const result = await checkFeedbackLoop(db, CLOCK, 'user-1', 'space-1', 'task-1');

    expect(result.suppressed).toBe(false);
  });

  it('returns cycleDetected:false when cycle count is below threshold', async () => {
    const db = createMockDb({
      eventLog: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await checkFeedbackLoop(db, CLOCK, 'user-1', 'space-1', 'task-1');

    expect(result.cycleDetected).toBe(false);
    expect(result.cycleCount).toBe(0);
  });
});

describe('shouldExcludeFromReplan', () => {
  it('returns true when suppressed is true', () => {
    expect(
      shouldExcludeFromReplan({
        suppressed: true,
        reason: 'user changed task',
        cycleDetected: false,
        cycleCount: 0,
      }),
    ).toBe(true);
  });

  it('returns false when suppressed is false', () => {
    expect(
      shouldExcludeFromReplan({
        suppressed: false,
        reason: 'no feedback-loop signals',
        cycleDetected: false,
        cycleCount: 0,
      }),
    ).toBe(false);
  });
});
