import { describe, it, expect } from 'vitest';
import { generateExplanations, generatePlanSummary } from '../explanation';
import type {
  PlanningInput,
  PlanningTask,
  ScheduledBlock,
  UnscheduledTask,
  PlanningConflict,
} from '../types';
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

describe('generateExplanations', () => {
  it('scheduled items get explanations', () => {
    const t1 = makeTask({ id: 't1', title: 'Task One' });
    const input = makeInput({ tasks: [t1] });
    const scheduled = [block('t1', 9, 10)];

    const explanations = generateExplanations(input, scheduled, [], []);

    const sched = explanations.filter((e) => e.reasonCode === 'SCHEDULED_PLACED');
    expect(sched).toHaveLength(1);
    expect(sched[0]!.itemId).toBe('t1');
    expect(sched[0]!.kind).toBe('TASK');
    expect(sched[0]!.message).toMatch(/Scheduled from/);
  });

  it('unscheduled items get explanations', () => {
    const t1 = makeTask({ id: 't1', title: 'Task One' });
    const input = makeInput({ tasks: [t1] });

    const unscheduled: UnscheduledTask[] = [
      {
        taskId: 't1',
        reasonCode: 'HARD_NO_SLOTS',
        message: 'No available slot of 60 minutes for "Task One".',
      },
    ];

    const explanations = generateExplanations(input, [], unscheduled, []);

    expect(explanations).toHaveLength(1);
    expect(explanations[0]!.itemId).toBe('t1');
    expect(explanations[0]!.reasonCode).toBe('HARD_NO_SLOTS');
    expect(explanations[0]!.message).toBe('No available slot of 60 minutes for "Task One".');
  });

  it('conflicts generate explanations for both items', () => {
    const t1 = makeTask({ id: 't1', title: 'Task One', priority: 'NORMAL' });
    const input = makeInput({ tasks: [t1] });

    const conflict: PlanningConflict = {
      type: 'TASK_CALENDAR_OVERLAP',
      itemIds: ['t1', 'cal-1'],
      description: '"Task One" overlaps with calendar event "Meeting".',
      resolution: 'Task displaced to respect calendar commitment.',
      reasonCode: 'CONFLICT_RESOLVED_BY_DELEGATION',
    };

    const explanations = generateExplanations(input, [], [], [conflict]);

    const related = explanations.filter((e) => e.reasonCode === 'CONFLICT_RESOLVED_BY_DELEGATION');
    expect(related).toHaveLength(2); // one per item in itemIds
    expect(related.map((e) => e.itemId)).toEqual(['t1', 'cal-1']);
    expect(related[0]!.message).toContain('overlaps with calendar event');
  });

  it('conflict explanations embed description and resolution', () => {
    const conflict: PlanningConflict = {
      type: 'TASK_TASK_OVERLAP',
      itemIds: ['a', 'b'],
      description: '"A" overlaps with "B".',
      resolution: 'Displaced "B" due to lower priority.',
      reasonCode: 'CONFLICT_RESOLVED_BY_PRIORITY',
    };

    const explanations = generateExplanations(makeInput(), [], [], [conflict]);

    expect(explanations).toHaveLength(2);
    expect(explanations[0]!.message).toBe(
      '"A" overlaps with "B". Displaced "B" due to lower priority.',
    );
  });

  it('no decisions → no explanations', () => {
    const explanations = generateExplanations(makeInput(), [], [], []);
    expect(explanations).toEqual([]);
  });
});

describe('generatePlanSummary', () => {
  it('formats summary with scheduled tasks only', () => {
    const summary = generatePlanSummary([block('t1', 9, 10)], [], [], DATE);

    expect(summary).toBe('2026-09-07: 1 task planned.');
  });

  it('pluralizes tasks', () => {
    const summary = generatePlanSummary([block('t1', 9, 10), block('t2', 10, 11)], [], [], DATE);

    expect(summary).toBe('2026-09-07: 2 tasks planned.');
  });

  it('includes deferred count when unscheduled tasks exist', () => {
    const unscheduled: UnscheduledTask[] = [
      { taskId: 't3', reasonCode: 'HARD_NO_SLOTS', message: 'No slot.' },
    ];

    const summary = generatePlanSummary([block('t1', 9, 10)], unscheduled, [], DATE);

    expect(summary).toBe('2026-09-07: 1 task planned, 1 deferred.');
  });

  it('includes resolved conflict count', () => {
    const conflict: PlanningConflict = {
      type: 'TASK_TASK_OVERLAP',
      itemIds: ['a', 'b'],
      description: '"A" overlaps with "B".',
      resolution: 'Displaced "B".',
      reasonCode: 'CONFLICT_RESOLVED_BY_PRIORITY',
    };

    const summary = generatePlanSummary([block('t1', 9, 10)], [], [conflict], DATE);

    expect(summary).toBe('2026-09-07: 1 task planned, 1 conflict resolved.');
  });

  it('zeros produce a bare plan line', () => {
    const summary = generatePlanSummary([], [], [], DATE);

    expect(summary).toBe('2026-09-07: 0 tasks planned.');
  });
});
