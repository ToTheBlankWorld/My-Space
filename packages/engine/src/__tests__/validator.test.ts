import { describe, it, expect } from 'vitest';
import { validatePlanningInput, normalizeTaskDurations } from '../validator';
import type { PlanningInput, PlanningTask } from '../types';
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

function makeTask(overrides: Partial<PlanningTask> = {}): PlanningTask {
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

describe('validatePlanningInput', () => {
  it('valid input → no violations', () => {
    const input = makeInput({ tasks: [makeTask()] });
    const result = validatePlanningInput(input);

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('missing userId → error violation', () => {
    const input = makeInput({ userId: '' });
    const result = validatePlanningInput(input);

    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.field === 'userId' && v.severity === 'error')).toBe(
      true,
    );
  });

  it('missing date → error violation', () => {
    const input = makeInput({ date: '' as CalendarDate });
    const result = validatePlanningInput(input);

    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.field === 'date' && v.severity === 'error')).toBe(true);
  });

  it('negative estimatedMinutes → error violation', () => {
    const input = makeInput({
      tasks: [makeTask({ estimatedMinutes: -30 as DurationMinutes })],
    });
    const result = validatePlanningInput(input);

    expect(result.valid).toBe(false);
    expect(
      result.violations.some(
        (v) => v.field === 'task[task-1].estimatedMinutes' && v.severity === 'error',
      ),
    ).toBe(true);
  });

  it('self-dependency → error violation', () => {
    const input = makeInput({
      tasks: [makeTask()],
      dependencies: [{ taskId: 'task-1', dependsOnId: 'task-1' }],
    });
    const result = validatePlanningInput(input);

    expect(result.valid).toBe(false);
    expect(
      result.violations.some(
        (v) => v.field === 'dependency' && v.message === 'self-dependency on task-1',
      ),
    ).toBe(true);
  });

  it('invalid working hours (start >= end) → error violation', () => {
    const input = makeInput({
      workingHours: [{ weekday: 'MONDAY', startMinute: 1020, endMinute: 540 }],
    });
    const result = validatePlanningInput(input);

    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.field === 'workingHours[MONDAY]')).toBe(true);
  });

  it('zero defaultTaskDurationMinutes → error violation', () => {
    const input = makeInput({
      planningPreferences: {
        ...makeInput().planningPreferences,
        defaultTaskDurationMinutes: 0 as DurationMinutes,
      },
    });
    const result = validatePlanningInput(input);

    expect(result.valid).toBe(false);
    expect(
      result.violations.some(
        (v) =>
          v.field === 'planningPreferences.defaultTaskDurationMinutes' && v.severity === 'error',
      ),
    ).toBe(true);
  });

  it('empty title → warning (not an error)', () => {
    const input = makeInput({
      tasks: [makeTask({ title: '' })],
    });
    const result = validatePlanningInput(input);

    expect(result.valid).toBe(true); // warnings don't invalidate
    expect(
      result.violations.some((v) => v.field === 'task[task-1].title' && v.severity === 'warning'),
    ).toBe(true);
  });
});

describe('normalizeTaskDurations', () => {
  it('fills default duration for tasks with null estimatedMinutes', () => {
    const tasks = [
      makeTask({ id: 't1', estimatedMinutes: null }),
      makeTask({ id: 't2', estimatedMinutes: 60 as DurationMinutes }),
    ];

    const result = normalizeTaskDurations(tasks, 45 as DurationMinutes);

    expect(result).toHaveLength(2);
    expect(result[0]!.estimatedMinutes).toBe(45);
    expect(result[1]!.estimatedMinutes).toBe(60);
  });

  it('returns new array, original tasks unchanged', () => {
    const tasks = [makeTask({ id: 't1', estimatedMinutes: null })];

    const result = normalizeTaskDurations(tasks, 45 as DurationMinutes);

    expect(tasks[0]!.estimatedMinutes).toBeNull();
    expect(result).not.toBe(tasks);
    expect(result[0]).not.toBe(tasks[0]);
  });
});
