import { describe, it, expect } from 'vitest';
import { enforceWorkload } from '../workload';
import type { PlanningInput, PlanningTask, ScheduledBlock } from '../types';
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

describe('enforceWorkload', () => {
  it('tasks under max focus budget → no changes', () => {
    const t1 = makeTask({ id: 't1', estimatedMinutes: 60 as DurationMinutes });
    const t2 = makeTask({ id: 't2', estimatedMinutes: 60 as DurationMinutes });
    const input = makeInput({
      tasks: [t1, t2],
      planningPreferences: {
        ...makeInput().planningPreferences,
        maxDailyFocusMinutes: 480 as DurationMinutes,
      },
    });

    const scheduled = [block('t1', 9, 10), block('t2', 10, 12)];

    const result = enforceWorkload(input, scheduled, []);

    expect(result.scheduled).toHaveLength(2);
    expect(result.unscheduled).toHaveLength(0);
  });

  it('tasks over max focus budget → exceeding tasks removed from schedule', () => {
    const t1 = makeTask({ id: 't1', title: 'First Task', estimatedMinutes: 60 as DurationMinutes });
    const t2 = makeTask({
      id: 't2',
      title: 'Second Task',
      estimatedMinutes: 60 as DurationMinutes,
    });
    const input = makeInput({
      tasks: [t1, t2],
      planningPreferences: {
        ...makeInput().planningPreferences,
        maxDailyFocusMinutes: 90 as DurationMinutes,
      },
    });

    // t1 = 60 min, t2 = 60 min → total 120, max 90 → t2 exceeds
    const scheduled = [block('t1', 9, 10), block('t2', 10, 11)];

    const result = enforceWorkload(input, scheduled, []);

    expect(result.scheduled.map((b) => b.itemId)).toEqual(['t1']);
    expect(result.unscheduled).toHaveLength(1);
    expect(result.unscheduled[0]!.taskId).toBe('t2');
    expect(result.unscheduled[0]!.reasonCode).toBe('UNSCHEDULED_WORKLOAD_EXCEEDED');
  });

  it('weekend with allowWeekendScheduling=false → tasks removed', () => {
    const saturday = '2026-09-12' as CalendarDate; // a Saturday
    const t1 = makeTask({ id: 't1', title: 'Weekend Task' });
    const input = makeInput({
      date: saturday,
      tasks: [t1],
      planningPreferences: {
        ...makeInput().planningPreferences,
        allowWeekendScheduling: false,
      },
    });

    const scheduled = [block('t1', 9, 10)];

    const result = enforceWorkload(input, scheduled, []);

    expect(result.scheduled).toHaveLength(0);
    expect(result.unscheduled).toHaveLength(1);
    expect(result.unscheduled[0]!.taskId).toBe('t1');
    expect(result.actions.some((a) => a.reasonCode === 'HARD_WEEKEND_BLOCKED')).toBe(true);
  });

  it('weekend with allowWeekendScheduling=true → tasks kept', () => {
    const saturday = '2026-09-12' as CalendarDate;
    const t1 = makeTask({ id: 't1', title: 'Weekend Task' });
    const input = makeInput({
      date: saturday,
      tasks: [t1],
      planningPreferences: {
        ...makeInput().planningPreferences,
        allowWeekendScheduling: true,
      },
    });

    const scheduled = [block('t1', 9, 10)];

    const result = enforceWorkload(input, scheduled, []);

    expect(result.scheduled).toHaveLength(1);
    expect(result.unscheduled).toHaveLength(0);
  });

  it('short break between tasks → SOFT_BREAK_REQUIRED action recorded', () => {
    const t1 = makeTask({ id: 't1', title: 'Task One' });
    const t2 = makeTask({ id: 't2', title: 'Task Two' });
    const input = makeInput({
      tasks: [t1, t2],
      planningPreferences: {
        ...makeInput().planningPreferences,
        minBreakMinutes: 15 as DurationMinutes,
      },
    });

    // Task 1: 09:00–10:00, Task 2: 10:00–11:00 → 0 minute break < 15
    const scheduled = [block('t1', 9, 10), block('t2', 10, 11)];

    const result = enforceWorkload(input, scheduled, []);

    const breakAction = result.actions.find((a) => a.reasonCode === 'SOFT_BREAK_REQUIRED');
    expect(breakAction).toBeDefined();
    expect(breakAction!.factors).toMatchObject({
      previousTaskId: 't1',
      breakMinutes: 0,
      minBreakMinutes: 15,
    });
  });

  it('sufficient break → no SOFT_BREAK_REQUIRED action', () => {
    const t1 = makeTask({ id: 't1', title: 'Task One' });
    const t2 = makeTask({ id: 't2', title: 'Task Two' });
    const input = makeInput({
      tasks: [t1, t2],
      planningPreferences: {
        ...makeInput().planningPreferences,
        minBreakMinutes: 15 as DurationMinutes,
      },
    });

    // 09:00–10:00 then 10:20–11:00 → 20 minute break ≥ 15
    const scheduled = [
      block('t1', 9, 10),
      {
        kind: 'TASK' as const,
        itemId: 't2',
        start: new Date(Date.UTC(2026, 8, 7, 10, 20)),
        end: new Date(Date.UTC(2026, 8, 7, 11, 0)),
        position: 1,
        reasonCode: 'SCHEDULED_PLACED' as const,
      },
    ];

    const result = enforceWorkload(input, scheduled, []);

    expect(result.actions.some((a) => a.reasonCode === 'SOFT_BREAK_REQUIRED')).toBe(false);
  });
});
