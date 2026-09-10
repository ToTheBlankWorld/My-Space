import { describe, it, expect } from 'vitest';
import { detectAndResolveConflicts } from '../conflicts';
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

describe('detectAndResolveConflicts', () => {
  it('no overlaps → no conflicts', () => {
    const t1 = makeTask({ id: 't1', title: 'Task 1', priority: 'NORMAL' });
    const t2 = makeTask({ id: 't2', title: 'Task 2', priority: 'NORMAL' });
    const input = makeInput({ tasks: [t1, t2] });

    const blocks = [block('t1', 9, 10), block('t2', 10, 11)];

    const result = detectAndResolveConflicts(blocks, input);

    expect(result.conflicts).toHaveLength(0);
    expect(result.displaced).toHaveLength(0);
    expect(result.resolved).toHaveLength(2);
  });

  it('two overlapping tasks → lower priority is displaced', () => {
    const high = makeTask({ id: 'high', title: 'High Task', priority: 'HIGH' });
    const low = makeTask({ id: 'low', title: 'Low Task', priority: 'LOW' });
    const input = makeInput({ tasks: [high, low] });

    // Both scheduled 9:00–10:00
    const blocks = [block('high', 9, 10), block('low', 9, 10)];

    const result = detectAndResolveConflicts(blocks, input);

    expect(result.displaced).toContain('low');
    expect(result.resolved.find((b) => b.itemId === 'low')).toBeUndefined();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.type).toBe('TASK_TASK_OVERLAP');
  });

  it('task overlapping calendar event → task displaced', () => {
    const t1 = makeTask({ id: 't1', title: 'Task 1', priority: 'HIGH' });
    const input = makeInput({
      tasks: [t1],
      calendarEvents: [
        {
          id: 'cal-1',
          startAt: new Date(Date.UTC(2026, 8, 7, 9, 30)),
          endAt: new Date(Date.UTC(2026, 8, 7, 10, 30)),
          isAllDay: false,
          status: 'CONFIRMED',
          title: 'Client Call',
        },
      ],
    });

    const blocks = [block('t1', 9, 11)];

    const result = detectAndResolveConflicts(blocks, input);

    expect(result.displaced).toContain('t1');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.type).toBe('TASK_CALENDAR_OVERLAP');
  });

  it('task scheduled outside working hours → displaced', () => {
    const t1 = makeTask({ id: 't1', title: 'Task 1', priority: 'NORMAL' });
    const input = makeInput({
      tasks: [t1],
      workingHours: [{ weekday: 'MONDAY', startMinute: 540, endMinute: 1020 }],
    });

    // Task at 18:00–19:00 is outside 9:00–17:00
    const blocks: ScheduledBlock[] = [
      {
        kind: 'TASK',
        itemId: 't1',
        start: new Date(Date.UTC(2026, 8, 7, 18, 0)),
        end: new Date(Date.UTC(2026, 8, 7, 19, 0)),
        position: 0,
        reasonCode: 'SCHEDULED_PLACED',
      },
    ];

    const result = detectAndResolveConflicts(blocks, input);

    expect(result.displaced).toContain('t1');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.type).toBe('TASK_OUTSIDE_WORKING_HOURS');
  });

  it('multiple overlaps resolved deterministically by priority', () => {
    const crit = makeTask({ id: 'crit', title: 'Critical', priority: 'CRITICAL' });
    const high = makeTask({ id: 'high', title: 'High', priority: 'HIGH' });
    const low = makeTask({ id: 'low', title: 'Low', priority: 'LOW' });
    const input = makeInput({ tasks: [crit, high, low] });

    // All three overlap from 9:00–11:00
    const blocks = [block('crit', 9, 11), block('high', 9, 11), block('low', 9, 11)];

    const result = detectAndResolveConflicts(blocks, input);

    // CRITICAL should survive, HIGH and LOW should be displaced
    expect(result.resolved.find((b) => b.itemId === 'crit')).toBeDefined();
    expect(result.displaced).toContain('high');
    expect(result.displaced).toContain('low');
    expect(result.conflicts).toHaveLength(2);
  });
});
