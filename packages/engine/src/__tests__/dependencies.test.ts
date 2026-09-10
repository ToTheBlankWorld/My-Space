import { describe, it, expect } from 'vitest';
import { resolveDependencies, hasCycle } from '../dependencies';
import type { PlanningInput, PlanningTask, ScheduledBlock, PlanningDependency } from '../types';
import type { CalendarDate, TimeZone, DurationMinutes } from '@space/types';

const DATE = '2026-09-07' as CalendarDate;
const TZ = 'UTC' as TimeZone;

function makeInput(overrides: Partial<PlanningInput> = {}): PlanningInput {
  return {
    userId: 'user-1',
    date: DATE,
    timeZone: TZ,
    planningPreferences: {
      defaultTaskDurationMinutes: 30 as DurationMinutes,
      preferredPlanningMinute: null,
      schedulingStrategy: 'BALANCED',
      autonomyLevel: 'AUTOMATICALLY_MANAGE',
      maxDailyFocusMinutes: 480 as DurationMinutes,
      minBreakMinutes: 0 as DurationMinutes,
      bufferMinutes: 0 as DurationMinutes,
      allowWeekendScheduling: false,
    },
    workingHours: [{ weekday: 'MONDAY', startMinute: 540, endMinute: 1020 }],
    tasks: [],
    calendarEvents: [],
    reminders: [],
    dependencies: [],
    existingItems: [],
    space: { id: 'space-1', planVersion: 1, status: 'DRAFT' },
    ...overrides,
  };
}

function makeTask(overrides: Partial<PlanningTask>): PlanningTask {
  return {
    id: 'task-1',
    title: 'Task 1',
    priority: 'NORMAL',
    status: 'INBOX',
    estimatedMinutes: 60 as DurationMinutes,
    dueAt: null,
    scheduledStart: null,
    scheduledEnd: null,
    goalId: null,
    ...overrides,
  };
}

function block(itemId: string, startHour: number, endHour: number): ScheduledBlock {
  return {
    kind: 'TASK',
    itemId,
    start: new Date(Date.UTC(2026, 8, 7, startHour, 0)),
    end: new Date(Date.UTC(2026, 8, 7, endHour, 0)),
    position: 0,
    reasonCode: 'SCHEDULED_PLACED',
  };
}

describe('resolveDependencies', () => {
  it('no dependencies → no changes', () => {
    const t1 = makeTask({ id: 't1' });
    const input = makeInput({ tasks: [t1], dependencies: [] });
    const scheduled = [block('t1', 9, 10)];

    const result = resolveDependencies(input, scheduled, []);

    expect(result.scheduled).toHaveLength(1);
    expect(result.scheduled[0]!.itemId).toBe('t1');
    expect(result.unscheduled).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it('A depends on B, both scheduled in correct order → no issues', () => {
    const tA = makeTask({ id: 'A', title: 'Task A' });
    const tB = makeTask({ id: 'B', title: 'Task B' });
    const deps: PlanningDependency[] = [{ taskId: 'A', dependsOnId: 'B' }];

    const input = makeInput({ tasks: [tA, tB], dependencies: deps });
    // B scheduled 9–10, A scheduled 10–11 (correct order)
    const scheduled = [block('B', 9, 10), block('A', 10, 11)];

    const result = resolveDependencies(input, scheduled, []);

    expect(result.scheduled).toHaveLength(2);
    expect(result.conflicts).toHaveLength(0);
    expect(result.unscheduled).toHaveLength(0);
  });

  it('A depends on B, A scheduled before B → A is displaced', () => {
    const tA = makeTask({ id: 'A', title: 'Task A' });
    const tB = makeTask({ id: 'B', title: 'Task B' });
    const deps: PlanningDependency[] = [{ taskId: 'A', dependsOnId: 'B' }];

    const input = makeInput({ tasks: [tA, tB], dependencies: deps });
    // A scheduled 9–10, B scheduled 10–11 (wrong order)
    const scheduled = [block('A', 9, 10), block('B', 10, 11)];

    const result = resolveDependencies(input, scheduled, []);

    expect(result.scheduled.find((b) => b.itemId === 'A')).toBeUndefined();
    expect(result.unscheduled.some((u) => u.taskId === 'A')).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.type).toBe('DEPENDENCY_MISSING_PREREQUISITE');
  });

  it('cycle (A→B→A) → both tasks reported unscheduled and flagged with DEPENDENCY_CYCLE', () => {
    const tA = makeTask({ id: 'A', title: 'Task A' });
    const tB = makeTask({ id: 'B', title: 'Task B' });
    const deps: PlanningDependency[] = [
      { taskId: 'A', dependsOnId: 'B' },
      { taskId: 'B', dependsOnId: 'A' },
    ];

    const input = makeInput({ tasks: [tA, tB], dependencies: deps });
    const scheduled = [block('A', 9, 10), block('B', 10, 11)];

    const result = resolveDependencies(input, scheduled, []);

    // Cycle tasks are added to unscheduled with UNSCHEDULED_DEPENDENCY_CHAIN…
    expect(result.unscheduled.map((u) => u.taskId).sort()).toEqual(['A', 'B']);
    expect(result.unscheduled.every((u) => u.reasonCode === 'UNSCHEDULED_DEPENDENCY_CHAIN')).toBe(
      true,
    );
    // …and each cycle member gets a DEPENDENCY_CYCLE conflict.
    expect(result.conflicts).toHaveLength(2);
    expect(result.conflicts.every((c) => c.type === 'DEPENDENCY_CYCLE')).toBe(true);
  });
});

describe('hasCycle', () => {
  it('returns false for a DAG (no cycles)', () => {
    const tasks = [makeTask({ id: 'A' }), makeTask({ id: 'B' }), makeTask({ id: 'C' })];
    const deps: PlanningDependency[] = [
      { taskId: 'A', dependsOnId: 'B' },
      { taskId: 'B', dependsOnId: 'C' },
    ];

    expect(hasCycle(tasks, deps)).toBe(false);
  });

  it('returns true for a cycle (A→B→A)', () => {
    const tasks = [makeTask({ id: 'A' }), makeTask({ id: 'B' })];
    const deps: PlanningDependency[] = [
      { taskId: 'A', dependsOnId: 'B' },
      { taskId: 'B', dependsOnId: 'A' },
    ];

    expect(hasCycle(tasks, deps)).toBe(true);
  });

  it('returns false for no dependencies', () => {
    const tasks = [makeTask({ id: 'A' }), makeTask({ id: 'B' })];
    expect(hasCycle(tasks, [])).toBe(false);
  });

  it('returns true for a self-dependency', () => {
    const tasks = [makeTask({ id: 'A' })];
    const deps: PlanningDependency[] = [{ taskId: 'A', dependsOnId: 'A' }];

    expect(hasCycle(tasks, deps)).toBe(true);
  });
});
