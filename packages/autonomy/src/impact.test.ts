import { describe, expect, it, vi } from 'vitest';

import type { Database } from '@space/database';
import type { CalendarDate, TimeZone } from '@space/types';

import { analyzeImpact } from './impact';
import type { AffectedSpace } from './types';

const createMockDb = (overrides: Record<string, unknown> = {}): Database =>
  ({
    task: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    space: { findFirst: vi.fn().mockResolvedValue(null) },
    calendarEvent: { findMany: vi.fn().mockResolvedValue([]) },
    taskDependency: { findMany: vi.fn().mockResolvedValue([]) },
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

const BASE_ARGS = {
  eventType: 'TASK_UPDATED',
  reasonCode: 'TASK_CHANGED',
  entityId: 'task-1',
};

describe('analyzeImpact', () => {
  it('returns no material impact when planVersion is 0', async () => {
    const db = createMockDb();
    const space = mockSpace({ planVersion: 0 });

    const result = await analyzeImpact(db, { db: db, space, ...BASE_ARGS });

    expect(result.hasMaterialImpact).toBe(false);
    expect(result.signals).toHaveLength(0);
    expect(result.maxClassification).toBe('NO_REPLAN');
  });

  it('returns no material impact when eventType is unknown', async () => {
    const db = createMockDb();
    const space = mockSpace();

    const result = await analyzeImpact(db, {
      db: db,
      space,
      eventType: 'UNKNOWN_EVENT',
      reasonCode: 'UNKNOWN',
    });

    expect(result.hasMaterialImpact).toBe(false);
    expect(result.signals).toHaveLength(0);
  });

  it('detects SCHEDULE_COLLISION when an updated task overlaps with another PLANNED task', async () => {
    const db = createMockDb({
      task: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'task-1',
          scheduledStart: new Date('2025-06-15T09:00:00Z'),
          scheduledEnd: new Date('2025-06-15T10:00:00Z'),
          estimatedMinutes: 60,
        }),
        findMany: vi.fn().mockResolvedValue([{ id: 'task-2', title: 'Overlapping task' }]),
        count: vi.fn().mockResolvedValue(0),
      },
    });
    const space = mockSpace();

    const result = await analyzeImpact(db, {
      db: db,
      space,
      ...BASE_ARGS,
    });

    const collision = result.signals.find((s) => s.kind === 'SCHEDULE_COLLISION');
    expect(collision).toBeDefined();
    expect(collision!.entityId).toBe('task-1');
    expect(collision!.escalation).toBe('REPLAN_REQUIRED');
    expect(result.hasMaterialImpact).toBe(true);
  });

  it('detects CALENDAR_DRIFT when calendar events changed in the planning horizon', async () => {
    const db = createMockDb({
      calendarEvent: {
        findMany: vi.fn().mockResolvedValue([{ id: 'cal-1', title: 'Team standup' }]),
      },
    });
    const space = mockSpace();

    const result = await analyzeImpact(db, {
      db: db,
      space,
      eventType: 'CALENDAR_CHANGED',
      reasonCode: 'CALENDAR_CHANGED',
      payload: { calendarId: 'cal-default' },
    });

    const drift = result.signals.find((s) => s.kind === 'CALENDAR_DRIFT');
    expect(drift).toBeDefined();
    expect(drift!.escalation).toBe('REPLAN_REQUIRED');
    expect(result.hasMaterialImpact).toBe(true);
  });

  it('detects DEADLINE_RISK when a task deadline is at risk', async () => {
    const db = createMockDb({
      task: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'task-1',
          dueAt: new Date('2025-06-15T12:00:00Z'),
          scheduledEnd: new Date('2025-06-15T14:00:00Z'),
        }),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    });
    const space = mockSpace();

    const result = await analyzeImpact(db, {
      db: db,
      space,
      ...BASE_ARGS,
    });

    const deadline = result.signals.find((s) => s.kind === 'DEADLINE_RISK');
    expect(deadline).toBeDefined();
    expect(deadline!.entityId).toBe('task-1');
    expect(deadline!.escalation).toBe('REPLAN_REQUIRED');
    expect(result.hasMaterialImpact).toBe(true);
  });

  it('detects DEADLINE_RISK when task has no scheduledEnd before dueAt', async () => {
    const db = createMockDb({
      task: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'task-1',
          dueAt: new Date('2025-06-15T12:00:00Z'),
          scheduledEnd: null,
        }),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    });
    const space = mockSpace();

    const result = await analyzeImpact(db, {
      db: db,
      space,
      ...BASE_ARGS,
    });

    const deadline = result.signals.find((s) => s.kind === 'DEADLINE_RISK');
    expect(deadline).toBeDefined();
  });

  it('detects DEPENDENCY_BREAK when other tasks depend on the changed task', async () => {
    const db = createMockDb({
      taskDependency: {
        findMany: vi.fn().mockResolvedValue([{ taskId: 'task-2' }, { taskId: 'task-3' }]),
      },
    });
    const space = mockSpace();

    const result = await analyzeImpact(db, {
      db: db,
      space,
      ...BASE_ARGS,
    });

    const depBreak = result.signals.find((s) => s.kind === 'DEPENDENCY_BREAK');
    expect(depBreak).toBeDefined();
    expect(depBreak!.entityId).toBe('task-1');
    expect(depBreak!.message).toContain('2');
    expect(depBreak!.escalation).toBe('REPLAN_REQUIRED');
    expect(result.hasMaterialImpact).toBe(true);
  });

  it('detects WORKLOAD_IMBALANCE when >12 open tasks in the space', async () => {
    let callIndex = 0;
    const db = createMockDb({
      task: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockImplementation(() => {
          const result = callIndex < 2 ? 15 : 0;
          callIndex++;
          return Promise.resolve(result);
        }),
      },
    });
    const space = mockSpace();

    const result = await analyzeImpact(db, {
      db: db,
      space,
      eventType: 'TASK_COMPLETED',
      reasonCode: 'TASK_COMPLETED',
    });

    const workload = result.signals.find((s) => s.kind === 'WORKLOAD_IMBALANCE');
    expect(workload).toBeDefined();
    expect(workload!.message).toContain('15');
    expect(workload!.escalation).toBe('REPLAN_REQUIRED');
    expect(result.hasMaterialImpact).toBe(true);
  });

  it('detects WORKLOAD_IMBALANCE when >3 open tasks but none are planned', async () => {
    let countCall = 0;
    const db = createMockDb({
      task: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockImplementation(() => {
          countCall++;
          // First call: openTasks=5, second call: plannedTasks=0
          if (countCall === 1) return Promise.resolve(5);
          return Promise.resolve(0);
        }),
      },
    });
    const space = mockSpace();

    const result = await analyzeImpact(db, {
      db: db,
      space,
      eventType: 'TASK_COMPLETED',
      reasonCode: 'TASK_COMPLETED',
    });

    const workload = result.signals.find((s) => s.kind === 'WORKLOAD_IMBALANCE');
    expect(workload).toBeDefined();
    expect(workload!.message).toContain('none are planned');
    expect(workload!.escalation).toBe('REPLAN_REQUIRED');
    expect(result.hasMaterialImpact).toBe(true);
  });

  it('detects NEWLY_AVAILABLE when eventType is TASK_COMPLETED', async () => {
    const db = createMockDb();
    const space = mockSpace();

    const result = await analyzeImpact(db, {
      db: db,
      space,
      eventType: 'TASK_COMPLETED',
      reasonCode: 'TASK_COMPLETED',
      entityId: 'task-1',
    });

    const available = result.signals.find((s) => s.kind === 'NEWLY_AVAILABLE');
    expect(available).toBeDefined();
    expect(available!.entityId).toBe('task-1');
    expect(available!.escalation).toBe('REPLAN_REQUIRED');
    expect(result.hasMaterialImpact).toBe(true);
  });

  it('detects NEWLY_AVAILABLE for TASK_UPDATED with CANCELLED status', async () => {
    const db = createMockDb();
    const space = mockSpace();

    const result = await analyzeImpact(db, {
      db: db,
      space,
      eventType: 'TASK_UPDATED',
      reasonCode: 'TASK_CHANGED',
      entityId: 'task-1',
      payload: { status: 'CANCELLED' },
    });

    const available = result.signals.find((s) => s.kind === 'NEWLY_AVAILABLE');
    expect(available).toBeDefined();
  });

  it('returns hasMaterialImpact: true when at least one signal is detected', async () => {
    const db = createMockDb({
      taskDependency: {
        findMany: vi.fn().mockResolvedValue([{ taskId: 'task-2' }]),
      },
    });
    const space = mockSpace();

    const result = await analyzeImpact(db, {
      db: db,
      space,
      ...BASE_ARGS,
    });

    expect(result.hasMaterialImpact).toBe(true);
    expect(result.signals.length).toBeGreaterThanOrEqual(1);
  });

  it('returns hasMaterialImpact: false when no signals are detected', async () => {
    const db = createMockDb();
    const space = mockSpace();

    // Only NEWLY_AVAILABLE fires; exclude that edge case by using no entityId
    const resultNoEntity = await analyzeImpact(db, {
      db: db,
      space,
      eventType: 'REMINDER_CREATED',
      reasonCode: 'REVIEW_ONLY',
    });

    expect(resultNoEntity.hasMaterialImpact).toBe(false);
  });

  it('maxClassification reflects the highest-severity signal', async () => {
    const db = createMockDb({
      task: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'task-1',
          scheduledStart: new Date('2025-06-15T09:00:00Z'),
          scheduledEnd: new Date('2025-06-15T10:00:00Z'),
          estimatedMinutes: 60,
          dueAt: new Date('2025-06-15T08:00:00Z'),
        }),
        findMany: vi.fn().mockResolvedValue([{ id: 'task-2', title: 'Overlap' }]),
        count: vi.fn().mockResolvedValue(0),
      },
    });
    const space = mockSpace();

    const result = await analyzeImpact(db, {
      db: db,
      space,
      ...BASE_ARGS,
    });

    // Both SCHEDULE_COLLISION and DEADLINE_RISK have REPLAN_REQUIRED
    expect(result.maxClassification).toBe('REPLAN_REQUIRED');
    expect(result.signals.length).toBeGreaterThanOrEqual(2);
  });

  it('maxClassification is NO_REPLAN when no signals detected', async () => {
    const db = createMockDb();
    const space = mockSpace();

    const result = await analyzeImpact(db, {
      db: db,
      space,
      eventType: 'REMINDER_CREATED',
      reasonCode: 'REVIEW_ONLY',
    });

    expect(result.maxClassification).toBe('NO_REPLAN');
  });

  it('includes correct metadata in result', async () => {
    const db = createMockDb();
    const space = mockSpace();

    const result = await analyzeImpact(db, {
      db: db,
      space,
      eventType: 'REMINDER_CREATED',
      reasonCode: 'REVIEW_ONLY',
    });

    expect(result.spaceId).toBe('space-1');
    expect(result.userId).toBe('user-1');
    expect(result.date).toBe('2025-06-15');
  });
});
