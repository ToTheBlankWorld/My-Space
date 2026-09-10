import { describe, it, expect } from 'vitest';
import { scheduleTasks } from '../scheduling';
import type { PlanningInput, PlanningTask, ScoredTask, AvailableSlot } from '../types';
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
      schedulingStrategy: 'EARLIEST_FIT',
      autonomyLevel: 'AUTOMATICALLY_MANAGE',
      maxDailyFocusMinutes: 480 as DurationMinutes,
      minBreakMinutes: 0 as DurationMinutes,
      bufferMinutes: 0 as DurationMinutes,
      allowWeekendScheduling: false,
    },
    workingHours: [],
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
    estimatedMinutes: 30 as DurationMinutes,
    dueAt: null,
    scheduledStart: null,
    scheduledEnd: null,
    goalId: null,
    ...overrides,
  };
}

function scoredTask(task: PlanningTask, score = 100): ScoredTask {
  return {
    task,
    score,
    deadlinePriority: task.dueAt ? task.dueAt.getTime() : Number.MAX_SAFE_INTEGER,
    priorityLevel:
      task.priority === 'CRITICAL'
        ? 0
        : task.priority === 'HIGH'
          ? 1
          : task.priority === 'NORMAL'
            ? 2
            : 3,
    stableId: task.id,
  };
}

function slot(startHour: number, endHour: number): AvailableSlot {
  const start = new Date(Date.UTC(2026, 8, 7, startHour, 0));
  const end = new Date(Date.UTC(2026, 8, 7, endHour, 0));
  return {
    start,
    end,
    durationMinutes: (endHour - startHour) * 60,
  };
}

describe('scheduleTasks', () => {
  it('single task fits in a single slot', () => {
    const task = makeTask({ id: 't1', estimatedMinutes: 60 as DurationMinutes });
    const scored = [scoredTask(task)];
    const slots = [slot(9, 17)];

    const result = scheduleTasks(scored, slots, makeInput());

    expect(result.scheduled).toHaveLength(1);
    expect(result.unscheduled).toHaveLength(0);
    expect(result.scheduled[0]!.itemId).toBe('t1');
    expect(result.scheduled[0]!.start.getUTCHours()).toBe(9);
    expect(result.scheduled[0]!.end.getUTCHours()).toBe(10);
  });

  it('multiple tasks placed sequentially in order', () => {
    const t1 = makeTask({ id: 't1', estimatedMinutes: 60 as DurationMinutes });
    const t2 = makeTask({ id: 't2', estimatedMinutes: 60 as DurationMinutes });
    const scored = [scoredTask(t1, 200), scoredTask(t2, 100)];
    const slots = [slot(9, 17)];

    const result = scheduleTasks(scored, slots, makeInput());

    expect(result.scheduled).toHaveLength(2);
    expect(result.scheduled[0]!.itemId).toBe('t1');
    expect(result.scheduled[0]!.start.getUTCHours()).toBe(9);
    expect(result.scheduled[1]!.itemId).toBe('t2');
    expect(result.scheduled[1]!.start.getUTCHours()).toBe(10);
  });

  it('task too large for any slot → unscheduled with HARD_NO_SLOTS', () => {
    const task = makeTask({ id: 't1', estimatedMinutes: 600 as DurationMinutes });
    const scored = [scoredTask(task)];
    const slots = [slot(9, 17)]; // 480 min available

    const result = scheduleTasks(scored, slots, makeInput());

    expect(result.scheduled).toHaveLength(0);
    expect(result.unscheduled).toHaveLength(1);
    expect(result.unscheduled[0]!.taskId).toBe('t1');
    expect(result.unscheduled[0]!.reasonCode).toBe('HARD_NO_SLOTS');
  });

  it('buffer time inserted between consecutive blocks', () => {
    const t1 = makeTask({ id: 't1', estimatedMinutes: 60 as DurationMinutes });
    const t2 = makeTask({ id: 't2', estimatedMinutes: 60 as DurationMinutes });
    const scored = [scoredTask(t1, 200), scoredTask(t2, 100)];
    const slots = [slot(9, 17)];

    const input = makeInput({
      planningPreferences: {
        ...makeInput().planningPreferences,
        bufferMinutes: 15 as DurationMinutes,
      },
    });

    const result = scheduleTasks(scored, slots, input);

    expect(result.scheduled).toHaveLength(2);
    // t1: 09:00–10:00, buffer 15 min, t2 starts at 10:15
    expect(result.scheduled[0]!.start.getUTCHours()).toBe(9);
    expect(result.scheduled[1]!.start.getUTCHours()).toBe(10);
    expect(result.scheduled[1]!.start.getUTCMinutes()).toBe(15);
  });

  it('EARLIEST_FIT places task in the first available slot (slots assumed pre-sorted)', () => {
    const t1 = makeTask({ id: 't1', estimatedMinutes: 60 as DurationMinutes });
    const scored = [scoredTask(t1)];

    const earlySlot: AvailableSlot = {
      start: new Date(Date.UTC(2026, 8, 7, 9, 0)),
      end: new Date(Date.UTC(2026, 8, 7, 12, 0)),
      durationMinutes: 180,
    };
    const lateSlot: AvailableSlot = {
      start: new Date(Date.UTC(2026, 8, 7, 14, 0)),
      end: new Date(Date.UTC(2026, 8, 7, 17, 0)),
      durationMinutes: 180,
    };

    // EARLIEST_FIT picks the first candidate that fits; the contract is that
    // available slots arrive sorted by start time.
    const input = makeInput({
      planningPreferences: {
        ...makeInput().planningPreferences,
        schedulingStrategy: 'EARLIEST_FIT',
      },
    });

    const result = scheduleTasks(scored, [earlySlot, lateSlot], input);

    expect(result.scheduled).toHaveLength(1);
    expect(result.scheduled[0]!.start.getUTCHours()).toBe(9);
  });

  it('BALANCED strategy prefers slot closest to preferredPlanningMinute', () => {
    const t1 = makeTask({ id: 't1', estimatedMinutes: 60 as DurationMinutes });
    const scored = [scoredTask(t1)];

    const morningSlot: AvailableSlot = {
      start: new Date(Date.UTC(2026, 8, 7, 9, 0)),
      end: new Date(Date.UTC(2026, 8, 7, 11, 0)),
      durationMinutes: 120,
    };
    const afternoonSlot: AvailableSlot = {
      start: new Date(Date.UTC(2026, 8, 7, 13, 0)),
      end: new Date(Date.UTC(2026, 8, 7, 15, 0)),
      durationMinutes: 120,
    };

    // Preferred at 14:00 (840 min) → afternoon slot is closer.
    const input = makeInput({
      planningPreferences: {
        ...makeInput().planningPreferences,
        schedulingStrategy: 'BALANCED',
        preferredPlanningMinute: 840,
      },
    });

    const result = scheduleTasks(scored, [morningSlot, afternoonSlot], input);

    expect(result.scheduled).toHaveLength(1);
    expect(result.scheduled[0]!.start.getUTCHours()).toBe(13);
  });
});
