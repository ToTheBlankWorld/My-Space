import { describe, it, expect } from 'vitest';
import { enforceDeadlines } from '../deadlines';
import type { PlanningInput, PlanningTask, ScheduledBlock, UnscheduledTask } from '../types';
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

describe('enforceDeadlines', () => {
  it('task scheduled before its deadline → no conflict', () => {
    // Deadline at 12:00, task ends at 11:00 — fine.
    const t1 = makeTask({
      id: 't1',
      title: 'On Time Task',
      dueAt: new Date(Date.UTC(2026, 8, 7, 12, 0)),
    });
    const input = makeInput({ tasks: [t1] });
    const scheduled = [block('t1', 9, 10)];

    const result = enforceDeadlines(input, scheduled, []);

    expect(result.conflicts).toHaveLength(0);
    expect(result.scheduled).toHaveLength(1);
  });

  it('task scheduled after its deadline → conflict flagged', () => {
    // Deadline at 10:00, task ends at 11:00 — too late.
    const t1 = makeTask({
      id: 't1',
      title: 'Late Task',
      dueAt: new Date(Date.UTC(2026, 8, 7, 10, 0)),
    });
    const input = makeInput({ tasks: [t1] });
    const scheduled = [block('t1', 9, 11)];

    const result = enforceDeadlines(input, scheduled, []);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.type).toBe('DEADLINE_UNREACHABLE');
    expect(result.conflicts[0]!.reasonCode).toBe('HARD_DEADLINE_CONFLICT');
  });

  it('unscheduled task with reachable deadline → noted but no unreachable conflict', () => {
    // Deadline at end of day, task needs 60 min — plenty of room.
    const t1 = makeTask({
      id: 't1',
      title: 'Reachable Task',
      dueAt: new Date(Date.UTC(2026, 8, 7, 23, 59)),
    });
    const input = makeInput({ tasks: [t1] });
    const scheduled: ScheduledBlock[] = [];
    const unscheduled: UnscheduledTask[] = [];

    const result = enforceDeadlines(input, scheduled, unscheduled);

    // No unreachable conflict since there's enough time.
    expect(result.conflicts).toHaveLength(0);
  });

  it('unscheduled task with unreachable deadline → UNSCHEDULED_DEADLINE_UNREACHABLE', () => {
    // Deadline at 09:30, task needs 60 min — needs to start at 08:30, but day starts at 00:00.
    // Actually 09:30 - 60min = 08:30, which is after day start (00:00), so it IS reachable.
    // Let's use a tighter scenario: deadline at 09:30, task needs 120 min.
    // 09:30 - 120min = 07:30, which IS after day start (00:00). Still reachable.
    // For truly unreachable: deadline at 09:00, task needs 60 min, but we're at 2026-09-07
    // and the engine checks if dueAt - durationMs < dayStart. dayStart = 2026-09-07T00:00.
    // dueAt 2026-09-07T00:30, duration 60 min = 09-07T(-00:30) → before day start → unreachable.
    const t1 = makeTask({
      id: 't1',
      title: 'Impossible Task',
      dueAt: new Date(Date.UTC(2026, 8, 7, 0, 30)),
      estimatedMinutes: 60 as DurationMinutes,
    });
    const input = makeInput({ tasks: [t1] });
    const scheduled: ScheduledBlock[] = [];
    const unscheduled: UnscheduledTask[] = [];

    const result = enforceDeadlines(input, scheduled, unscheduled);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.type).toBe('DEADLINE_UNREACHABLE');
    expect(result.unscheduled).toHaveLength(1);
    expect(result.unscheduled[0]!.reasonCode).toBe('UNSCHEDULED_DEADLINE_UNREACHABLE');
  });

  it('task with deadline after day end is not processed by deadline enforcement', () => {
    // Deadline is next day — outside planning horizon.
    const t1 = makeTask({
      id: 't1',
      title: 'Future Deadline',
      dueAt: new Date(Date.UTC(2026, 8, 8, 12, 0)),
    });
    const input = makeInput({ tasks: [t1] });
    const scheduled = [block('t1', 9, 10)];

    const result = enforceDeadlines(input, scheduled, []);

    // Task is not a deadline task for this day, so no conflict.
    expect(result.conflicts).toHaveLength(0);
  });
});
