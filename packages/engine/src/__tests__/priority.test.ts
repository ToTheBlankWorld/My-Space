import { describe, it, expect } from 'vitest';
import { scoreAndSortTasks } from '../priority';
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

describe('scoreAndSortTasks', () => {
  it('CRITICAL tasks score higher than HIGH > NORMAL > LOW', () => {
    const tasks = [
      makeTask({ id: 'low', priority: 'LOW' }),
      makeTask({ id: 'normal', priority: 'NORMAL' }),
      makeTask({ id: 'high', priority: 'HIGH' }),
      makeTask({ id: 'critical', priority: 'CRITICAL' }),
    ];

    const scored = scoreAndSortTasks(tasks, makeInput());
    const ids = scored.map((s) => s.task.id);

    expect(ids).toEqual(['critical', 'high', 'normal', 'low']);
  });

  it('deadline proximity boosts score: sooner deadline ranks higher', () => {
    const tasks = [
      makeTask({ id: 'far', priority: 'NORMAL', dueAt: new Date(Date.UTC(2026, 8, 14)) }),
      makeTask({ id: 'near', priority: 'NORMAL', dueAt: new Date(Date.UTC(2026, 8, 8)) }),
    ];

    const scored = scoreAndSortTasks(tasks, makeInput());
    expect(scored[0]!.task.id).toBe('near');
    expect(scored[1]!.task.id).toBe('far');
  });

  it('task without deadline gets baseline score', () => {
    const tasks = [makeTask({ id: 'no-deadline', priority: 'NORMAL', dueAt: null })];

    const scored = scoreAndSortTasks(tasks, makeInput());

    expect(scored).toHaveLength(1);
    expect(scored[0]!.deadlinePriority).toBe(Number.MAX_SAFE_INTEGER);
    expect(scored[0]!.score).toBeGreaterThan(0);
  });

  it('EARLIEST_FIT strategy adds no deadline or priority amplification', () => {
    const task = makeTask({
      id: 'near',
      priority: 'NORMAL',
      dueAt: new Date(Date.UTC(2026, 8, 8)), // 24h after the anchor date
    });

    const input = makeInput({
      planningPreferences: {
        ...makeInput().planningPreferences,
        schedulingStrategy: 'EARLIEST_FIT',
      },
    });

    const scored = scoreAndSortTasks([task], input);

    // priority 50*3 + deadline (100-24)*2 + duration (30 min → 8) + strategy 0
    expect(scored[0]!.score).toBe(150 + 152 + 8);
  });

  it('DEADLINE_FIRST strategy amplifies deadline score', () => {
    const tasks = [
      makeTask({ id: 'with-deadline', priority: 'NORMAL', dueAt: new Date(Date.UTC(2026, 8, 8)) }),
      makeTask({ id: 'no-deadline', priority: 'NORMAL', dueAt: null }),
    ];

    const withStrategy = (strategy: 'EARLIEST_FIT' | 'DEADLINE_FIRST') =>
      makeInput({
        planningPreferences: {
          ...makeInput().planningPreferences,
          schedulingStrategy: strategy,
        },
      });

    const earliest = scoreAndSortTasks(tasks, withStrategy('EARLIEST_FIT'));
    const deadlineFirst = scoreAndSortTasks(tasks, withStrategy('DEADLINE_FIRST'));

    const withDl = (scored: ReturnType<typeof scoreAndSortTasks>) =>
      scored.find((s) => s.task.id === 'with-deadline')!;
    const noDl = (scored: ReturnType<typeof scoreAndSortTasks>) =>
      scored.find((s) => s.task.id === 'no-deadline')!;

    // DEADLINE_FIRST adds exactly +30 for tasks with a deadline…
    expect(withDl(deadlineFirst).score).toBe(withDl(earliest).score + 30);
    // …and nothing for tasks without one.
    expect(noDl(deadlineFirst).score).toBe(noDl(earliest).score);
  });

  it('stable tie-breaking: same priority, same deadline → sorted by id', () => {
    const tasks = [
      makeTask({ id: 'task-b', priority: 'NORMAL', dueAt: null }),
      makeTask({ id: 'task-a', priority: 'NORMAL', dueAt: null }),
    ];

    const scored = scoreAndSortTasks(tasks, makeInput());
    const ids = scored.map((s) => s.task.id);

    // When score, deadlinePriority, and priorityLevel are all equal,
    // stableId (task id) breaks the tie alphabetically.
    expect(ids).toEqual(['task-a', 'task-b']);
  });

  it('duration weight: shorter tasks scored slightly higher', () => {
    const tasks = [
      makeTask({ id: 'long', priority: 'NORMAL', estimatedMinutes: 120 as DurationMinutes }),
      makeTask({ id: 'short', priority: 'NORMAL', estimatedMinutes: 10 as DurationMinutes }),
    ];

    const scored = scoreAndSortTasks(tasks, makeInput());
    expect(scored[0]!.task.id).toBe('short');
    expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
  });

  it('BALANCED strategy boosts CRITICAL and HIGH priority', () => {
    const tasks = [
      makeTask({ id: 'normal', priority: 'NORMAL' }),
      makeTask({ id: 'critical', priority: 'CRITICAL' }),
    ];

    const input = makeInput({
      planningPreferences: {
        ...makeInput().planningPreferences,
        schedulingStrategy: 'BALANCED',
      },
    });

    const scored = scoreAndSortTasks(tasks, input);
    expect(scored[0]!.task.id).toBe('critical');
  });
});
