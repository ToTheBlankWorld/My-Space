import { describe, expect, it, vi } from 'vitest';

import type { Database } from '@space/database';
import { FixedClock } from '@space/time';
import type { CalendarDate, TimeZone } from '@space/types';

import { evaluateAutonomy, isTaskProtected, getRecentUserChanges } from './policy';

const CLOCK = new FixedClock('2025-06-15T12:00:00Z');

const createMockDb = (overrides: Record<string, unknown> = {}): Database =>
  ({
    planningPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
    task: { findMany: vi.fn().mockResolvedValue([]) },
    eventLog: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => fn({})),
    ...overrides,
  }) as unknown as Database;

const mockSpace = (overrides = {}) => ({
  userId: 'user-1',
  spaceId: 'space-1',
  date: '2025-06-15' as CalendarDate,
  timeZone: 'UTC' as TimeZone,
  planVersion: 1,
  optimizedAt: new Date('2025-06-15T00:00:00Z'),
  ...overrides,
});

describe('evaluateAutonomy', () => {
  it('returns allowed:false when autonomy level is SUGGEST_ONLY', async () => {
    const db = createMockDb({
      planningPreferences: {
        findUnique: vi.fn().mockResolvedValue({ autonomyLevel: 'SUGGEST_ONLY' }),
      },
    });

    const decision = await evaluateAutonomy(db, CLOCK, {
      db,
      userId: 'user-1',
      space: mockSpace(),
      eventType: 'TASK_CREATED',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.autonomyLevel).toBe('SUGGEST_ONLY');
    expect(decision.protectedTaskIds).toEqual([]);
  });

  it('returns allowed:true when autonomy level is AUTOMATICALLY_MANAGE', async () => {
    const db = createMockDb({
      planningPreferences: {
        findUnique: vi.fn().mockResolvedValue({ autonomyLevel: 'AUTOMATICALLY_MANAGE' }),
      },
    });

    const decision = await evaluateAutonomy(db, CLOCK, {
      db,
      userId: 'user-1',
      space: mockSpace(),
      eventType: 'TASK_CREATED',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.autonomyLevel).toBe('AUTOMATICALLY_MANAGE');
  });

  it('returns allowed:true when autonomy level is ASK_BEFORE_CHANGING with TASK_CREATED event', async () => {
    const db = createMockDb({
      planningPreferences: {
        findUnique: vi.fn().mockResolvedValue({ autonomyLevel: 'ASK_BEFORE_CHANGING' }),
      },
    });

    const decision = await evaluateAutonomy(db, CLOCK, {
      db,
      userId: 'user-1',
      space: mockSpace(),
      eventType: 'TASK_CREATED',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.autonomyLevel).toBe('ASK_BEFORE_CHANGING');
  });

  it('defaults to ASK_BEFORE_CHANGING when no prefs row exists', async () => {
    const db = createMockDb();

    const decision = await evaluateAutonomy(db, CLOCK, {
      db,
      userId: 'user-1',
      space: mockSpace(),
      eventType: 'TASK_CREATED',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.autonomyLevel).toBe('ASK_BEFORE_CHANGING');
  });

  it('includes protected task IDs when IN_PROGRESS tasks exist', async () => {
    const now = new Date();
    const db = createMockDb({
      planningPreferences: {
        findUnique: vi.fn().mockResolvedValue({ autonomyLevel: 'AUTOMATICALLY_MANAGE' }),
      },
      task: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'task-1', updatedAt: now },
          { id: 'task-2', updatedAt: now },
        ]),
      },
    });

    const decision = await evaluateAutonomy(db, CLOCK, {
      db,
      userId: 'user-1',
      space: mockSpace(),
      eventType: 'TASK_CREATED',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.protectedTaskIds).toContain('task-1');
    expect(decision.protectedTaskIds).toContain('task-2');
  });
});

describe('isTaskProtected', () => {
  it('returns true when taskId is in the protected list', () => {
    expect(isTaskProtected(['task-1', 'task-2'], 'task-1')).toBe(true);
  });

  it('returns false when taskId is not in the protected list', () => {
    expect(isTaskProtected(['task-1', 'task-2'], 'task-3')).toBe(false);
  });
});

describe('getRecentUserChanges', () => {
  it('returns empty array when no user-initiated events exist', async () => {
    const db = createMockDb();
    const result = await getRecentUserChanges(db, CLOCK, 'user-1', 'space-1');

    expect(result).toEqual([]);
  });

  it('returns changes when TASK_COMPLETED events with trigger:"user" exist', async () => {
    const now = new Date();
    const db = createMockDb({
      eventLog: {
        findMany: vi.fn().mockResolvedValue([
          {
            eventType: 'TASK_COMPLETED',
            aggregateId: 'task-done-1',
            occurredAt: now,
            payload: { trigger: 'user', status: 'COMPLETED' },
          },
        ]),
      },
    });

    const result = await getRecentUserChanges(db, CLOCK, 'user-1', 'space-1');

    expect(result).toHaveLength(1);
    expect(result[0]!.taskId).toBe('task-done-1');
    expect(result[0]!.changeType).toBe('COMPLETED');
  });
});
