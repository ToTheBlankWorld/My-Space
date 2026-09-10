import { createLogger } from '@space/logger';
import { plan } from '@space/engine';
import { asCalendarDate, FixedClock, instantAtLocalTime, toDatabaseDate } from '@space/time';
import type { CalendarDate } from '@space/types';
import { describe, expect, it } from 'vitest';

import { PlanInputInvalidError, PlanInvalidDateError } from './errors';
import { persistPlanningResult } from './persist';
import { createPlanSpaceService } from './service';
import type { PlanSpaceService } from './service';
import { loadPlanningInput } from './snapshot';
import { createFakeDatabase } from './testing/fake-database';
import type { FakeDatabaseHandle, FakeRow } from './testing/fake-database';

const USER = 'usr-plan-000000000000000001';
const DATE: CalendarDate = asCalendarDate('2026-03-30'); // a Monday
const TZ = 'Europe/Lisbon';
const INSTANT = '2026-03-30T09:00:00.000Z';

const at = (minuteOfDay: number): Date => instantAtLocalTime(DATE, minuteOfDay, TZ);

const testLogger = () =>
  createLogger({ name: 'planning-test', level: 'fatal', destination: { write: () => {} } });

const seedWorkingHours = (handle: FakeDatabaseHandle): void => {
  handle.insert('workingHoursBlock', {
    userId: USER,
    weekday: 'MONDAY',
    startMinute: 540,
    endMinute: 780,
  });
  handle.insert('workingHoursBlock', {
    userId: USER,
    weekday: 'MONDAY',
    startMinute: 840,
    endMinute: 1080,
  });
};

interface ProfileOverrides {
  autonomyLevel?: string;
  schedulingStrategy?: string;
  timeZone?: string;
  defaultTaskDurationMinutes?: number;
  maxDailyFocusMinutes?: number;
}

const seedProfile = (handle: FakeDatabaseHandle, overrides: ProfileOverrides = {}): void => {
  const {
    autonomyLevel = 'AUTOMATICALLY_MANAGE',
    schedulingStrategy = 'EARLIEST_FIT',
    timeZone = TZ,
    defaultTaskDurationMinutes = 60,
    maxDailyFocusMinutes = 360,
  } = overrides;

  handle.insert('userPreferences', { userId: USER, timeZone });
  handle.insert('planningPreferences', {
    userId: USER,
    defaultTaskDurationMinutes,
    preferredPlanningMinute: null,
    schedulingStrategy,
    autonomyLevel,
    maxDailyFocusMinutes,
    minBreakMinutes: 10,
    bufferMinutes: 5,
    allowWeekendScheduling: false,
  });
};

const seedSpace = (handle: FakeDatabaseHandle, overrides: Partial<FakeRow> = {}): string => {
  handle.insert('space', {
    id: 'spc-plan-today',
    userId: USER,
    date: toDatabaseDate(DATE),
    timeZone: TZ,
    status: 'DRAFT',
    summary: null,
    planVersion: 0,
    plannedAt: null,
    optimizedAt: null,
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  });
  return 'spc-plan-today';
};

interface SeedTask {
  id: string;
  title: string;
  spaceId?: string | null;
  userId?: string;
  priority?: string;
  status?: string;
  estimatedMinutes?: number;
  dueAt?: Date | null;
  scheduledStart?: Date | null;
  scheduledEnd?: Date | null;
}

const seedTask = (handle: FakeDatabaseHandle, task: SeedTask): void => {
  handle.insert('task', {
    id: task.id,
    userId: task.userId ?? USER,
    spaceId: task.spaceId ?? null,
    goalId: null,
    title: task.title,
    description: null,
    priority: task.priority ?? 'NORMAL',
    status: task.status ?? 'INBOX',
    estimatedMinutes: task.estimatedMinutes ?? 60,
    actualMinutes: null,
    dueAt: task.dueAt ?? null,
    scheduledStart: task.scheduledStart ?? null,
    scheduledEnd: task.scheduledEnd ?? null,
    completedAt: null,
  });
};

const makeService = (
  handle: FakeDatabaseHandle,
  clock = new FixedClock(INSTANT),
): PlanSpaceService => createPlanSpaceService({ db: handle.db, clock, logger: testLogger() });

const completedPlans = (handle: FakeDatabaseHandle): number =>
  handle.rows('eventLog').filter((event) => event.eventType === 'PLANNING_COMPLETED').length;

describe('planSpace', () => {
  it('creates a space lazily and plans an empty day to revision 1', async () => {
    const handle = createFakeDatabase();
    seedProfile(handle);
    const service = makeService(handle);

    const result = await service.planSpace({ userId: USER, date: DATE });

    expect(result.planVersion).toBe(1);
    expect(result.mode).toBe('applied');
    expect(result.applied).toBe(true);
    expect(result.scheduledItems).toEqual([]);
    expect(result.unscheduledTasks).toEqual([]);
    expect(result.conflicts).toEqual([]);

    const day = await service.getDayState({ userId: USER, date: DATE });
    expect(day.spaceId).toBeDefined();
    expect(day.status).toBe('ACTIVE');
    expect(day.planVersion).toBe(1);
    expect(day.planned).toEqual([]);
    expect(day.unscheduled).toEqual([]);
    expect(day.latestPlan?.mode).toBe('applied');
    expect(day.latestPlan?.scheduled).toBe(0);
  });

  it('schedules an open task into working hours', async () => {
    const handle = createFakeDatabase();
    seedProfile(handle);
    seedWorkingHours(handle);
    seedSpace(handle);
    seedTask(handle, {
      id: 'tsk-aaa-001',
      title: 'Focused work',
      priority: 'HIGH',
      spaceId: 'spc-plan-today',
      estimatedMinutes: 60,
    });
    const service = makeService(handle);

    const result = await service.planSpace({ userId: USER, date: DATE });

    const block = result.scheduledItems.find((item) => item.itemId === 'tsk-aaa-001');
    expect(block).toBeDefined();
    expect(block?.kind).toBe('TASK');
    expect(block?.title).toBe('Focused work');
    expect(block?.priority).toBe('HIGH');
    expect(block?.start && block?.end).toBeTruthy();
    expect((Number(block?.end) - Number(block?.start)) / 60_000).toBe(60);

    const day = await service.getDayState({ userId: USER, date: DATE });
    expect(day.planned.map((item) => item.itemId)).toContain('tsk-aaa-001');
    expect(day.unscheduled).toEqual([]);
  });

  it('reports a task as unscheduled when there is no availability', async () => {
    const handle = createFakeDatabase();
    seedProfile(handle);
    seedSpace(handle);
    seedTask(handle, { id: 'tsk-aaa-001', title: 'Lonely task', spaceId: 'spc-plan-today' });
    const service = makeService(handle);

    const result = await service.planSpace({ userId: USER, date: DATE });

    expect(result.unscheduledTasks.map((task) => task.taskId)).toContain('tsk-aaa-001');
    expect(result.scheduledItems).toEqual([]);

    const day = await service.getDayState({ userId: USER, date: DATE });
    expect(day.planned).toEqual([]);
    expect(day.unscheduled.map((task) => task.id)).toContain('tsk-aaa-001');
  });

  it('respects a hard deadline: the scheduled block ends before the due instant', async () => {
    const handle = createFakeDatabase();
    seedProfile(handle);
    seedWorkingHours(handle);
    seedSpace(handle);
    const dueAt = at(1020); // 17:00 local
    seedTask(handle, {
      id: 'tsk-deadline',
      title: 'Quarterly report',
      priority: 'CRITICAL',
      spaceId: 'spc-plan-today',
      estimatedMinutes: 90,
      dueAt,
    });
    const service = makeService(handle);

    const result = await service.planSpace({ userId: USER, date: DATE });

    const block = result.scheduledItems.find((item) => item.itemId === 'tsk-deadline');
    expect(block?.end).toBeTruthy();
    if (block?.end) {
      expect(block.end.getTime()).toBeLessThanOrEqual(dueAt.getTime());
    }
  });

  it('keeps tasks out of calendar blocks', async () => {
    const handle = createFakeDatabase();
    seedProfile(handle);
    seedWorkingHours(handle);
    seedSpace(handle);
    const eventStart = at(570); // 09:30 local
    const eventEnd = at(630); // 10:30 local
    handle.insert('calendarEvent', {
      id: 'evt-standup',
      userId: USER,
      calendarId: 'cal-work',
      spaceId: 'spc-plan-today',
      externalId: 'g-standup',
      title: 'Stand-up',
      startAt: eventStart,
      endAt: eventEnd,
      timeZone: TZ,
      status: 'CONFIRMED',
      deletedAt: null,
    });
    seedTask(handle, {
      id: 'tsk-aaa-001',
      title: 'Deep work',
      spaceId: 'spc-plan-today',
      estimatedMinutes: 60,
    });
    const service = makeService(handle);

    const result = await service.planSpace({ userId: USER, date: DATE });

    for (const item of result.scheduledItems.filter((entry) => entry.kind === 'TASK')) {
      if (!item.start || !item.end) {
        continue;
      }
      const overlaps =
        item.start.getTime() < eventEnd.getTime() && eventStart.getTime() < item.end.getTime();
      expect(overlaps).toBe(false);
    }
  });

  it('adds an overlapping calendar event to the authoritative day view', async () => {
    const handle = createFakeDatabase();
    seedProfile(handle);
    seedSpace(handle);
    handle.insert('calendarEvent', {
      id: 'evt-standup',
      userId: USER,
      calendarId: 'cal-work',
      spaceId: 'spc-plan-today',
      externalId: 'g-standup',
      title: 'Stand-up',
      startAt: at(570),
      endAt: at(630),
      timeZone: TZ,
      status: 'CONFIRMED',
      deletedAt: null,
    });
    const service = makeService(handle);

    const day = await service.getDayState({ userId: USER, date: DATE });

    expect(day.planned.some((item) => item.itemId === 'evt-standup')).toBe(true);
  });

  it('only plans the requesting user’s own tasks', async () => {
    const handle = createFakeDatabase();
    seedProfile(handle);
    seedWorkingHours(handle);
    seedSpace(handle);
    seedTask(handle, { id: 'tsk-own-001', title: 'Mine', spaceId: 'spc-plan-today' });
    seedTask(handle, {
      id: 'tsk-theirs-001',
      title: 'Their task',
      userId: 'usr-someone-else',
      spaceId: 'spc-plan-today',
    });
    const service = makeService(handle);

    const result = await service.planSpace({ userId: USER, date: DATE });

    const ids = result.scheduledItems.map((item) => item.itemId);
    expect(ids).toContain('tsk-own-001');
    expect(ids).not.toContain('tsk-theirs-001');
  });
});

describe('autonomy levels', () => {
  it('persists nothing under SUGGEST_ONLY and still records the actions', async () => {
    const handle = createFakeDatabase();
    seedProfile(handle, { autonomyLevel: 'SUGGEST_ONLY' });
    seedWorkingHours(handle);
    seedSpace(handle);
    seedTask(handle, { id: 'tsk-aaa-001', title: 'Just a suggestion', spaceId: 'spc-plan-today' });
    const service = makeService(handle);

    const result = await service.planSpace({ userId: USER, date: DATE });

    expect(result.mode).toBe('suggest-only');
    expect(result.applied).toBe(false);
    expect(result.scheduledItems).toHaveLength(1);

    const day = await service.getDayState({ userId: USER, date: DATE });
    expect(day.status).toBe('DRAFT');
    expect(day.planVersion).toBe(0);
    expect(day.planned).toEqual([]);

    const actions = handle.rows('agentAction');
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => action.outcome === 'SKIPPED')).toBe(true);
  });

  it('under ASK_BEFORE_CHANGING leaves existing placements untouched', async () => {
    const handle = createFakeDatabase();
    seedProfile(handle, { autonomyLevel: 'ASK_BEFORE_CHANGING' });
    seedWorkingHours(handle);
    seedSpace(handle);

    const existingStart = at(540);
    const existingEnd = at(600);
    seedTask(handle, {
      id: 'tsk-aaa-001',
      title: 'Already placed',
      spaceId: 'spc-plan-today',
      scheduledStart: existingStart,
      scheduledEnd: existingEnd,
    });
    handle.insert('spaceItem', {
      id: 'itm-A',
      userId: USER,
      spaceId: 'spc-plan-today',
      kind: 'TASK',
      taskId: 'tsk-aaa-001',
      position: 0,
      scheduledStart: existingStart,
      scheduledEnd: existingEnd,
      createdAt: at(0),
      updatedAt: at(0),
    });
    seedTask(handle, { id: 'tsk-aaa-002', title: 'New arrival', spaceId: 'spc-plan-today' });
    const service = makeService(handle);

    const result = await service.planSpace({ userId: USER, date: DATE });

    expect(result.mode).toBe('ask-before-changing');
    expect(result.applied).toBe(false);

    const day = await service.getDayState({ userId: USER, date: DATE });
    const placedA = day.planned.find((item) => item.itemId === 'tsk-aaa-001');
    expect(placedA?.start?.getTime()).toBe(existingStart.getTime());
    expect(day.planned.some((item) => item.itemId === 'tsk-aaa-002')).toBe(true);
  });

  it('under AUTOMATICALLY_MANAGE applies the full plan, moving existing items', async () => {
    const handle = createFakeDatabase();
    seedProfile(handle, { autonomyLevel: 'AUTOMATICALLY_MANAGE' });
    seedWorkingHours(handle);
    seedSpace(handle);

    const existingStart = at(540);
    const existingEnd = at(600);
    seedTask(handle, {
      id: 'tsk-aaa-001',
      title: 'Can be moved',
      spaceId: 'spc-plan-today',
      scheduledStart: existingStart,
      scheduledEnd: existingEnd,
    });
    handle.insert('spaceItem', {
      id: 'itm-A',
      userId: USER,
      spaceId: 'spc-plan-today',
      kind: 'TASK',
      taskId: 'tsk-aaa-001',
      position: 0,
      scheduledStart: existingStart,
      scheduledEnd: existingEnd,
      createdAt: at(0),
      updatedAt: at(0),
    });
    seedTask(handle, { id: 'tsk-aaa-002', title: 'Another task', spaceId: 'spc-plan-today' });
    const service = makeService(handle);

    const result = await service.planSpace({ userId: USER, date: DATE });

    expect(result.mode).toBe('applied');
    expect(result.applied).toBe(true);

    const actions = handle.rows('agentAction');
    expect(actions.some((action) => action.outcome === 'SUCCEEDED')).toBe(true);
  });
});

describe('concurrency and persistence guarantees', () => {
  it('coalesces duplicate in-flight requests into one pass', async () => {
    const handle = createFakeDatabase();
    seedProfile(handle);
    seedWorkingHours(handle);
    seedSpace(handle);
    seedTask(handle, { id: 'tsk-aaa-001', title: 'One task', spaceId: 'spc-plan-today' });
    const service = makeService(handle);

    const [first, second] = await Promise.all([
      service.planSpace({ userId: USER, date: DATE }),
      service.planSpace({ userId: USER, date: DATE }),
    ]);

    expect(first).toBe(second);
    expect(completedPlans(handle)).toBe(1);
    expect(handle.rows('space').length).toBe(1);
  });

  it('re-plans an already-planned day as the next revision', async () => {
    const handle = createFakeDatabase();
    seedProfile(handle);
    seedWorkingHours(handle);
    seedSpace(handle);
    seedTask(handle, { id: 'tsk-aaa-001', title: 'Moved meanwhile', spaceId: 'spc-plan-today' });
    const service = makeService(handle);

    const first = await service.planSpace({ userId: USER, date: DATE });
    expect(first.applied).toBe(true);
    expect(first.planVersion).toBe(1);
    expect(handle.rows('space')[0]?.planVersion).toBe(1);

    // A second click is an explicit re-plan: it loads the current version and
    // claims the next one under the compare-and-swap, never a clobber.
    const again = await service.planSpace({ userId: USER, date: DATE });
    expect(again.applied).toBe(true);
    expect(again.planVersion).toBe(2);
    expect(completedPlans(handle)).toBe(2);
  });

  it('skips persistence when the space version moved underneath the pass', async () => {
    const handle = createFakeDatabase();
    seedProfile(handle);
    seedWorkingHours(handle);
    seedSpace(handle);
    seedTask(handle, { id: 'tsk-aaa-001', title: 'Stale pass', spaceId: 'spc-plan-today' });
    const clock = new FixedClock(INSTANT);

    // A concurrent pass committed revision 1 while this pass still holds 0.
    const input = await loadPlanningInput(handle.db, testLogger(), {
      userId: USER,
      date: DATE,
      spaceId: 'spc-plan-today',
      space: { id: 'spc-plan-today', planVersion: 0, status: 'DRAFT' },
      maxTasksPerPlan: 100,
    });
    const computed = plan(input, clock);

    // A concurrent pass has already committed revision 1; this pass still holds 0.
    const spaceRow = handle.rows('space')[0] as FakeRow;
    spaceRow.planVersion = 1;

    const outcome = await persistPlanningResult(handle.db, clock, {
      userId: USER,
      spaceId: 'spc-plan-today',
      planVersion: 0, // the version the stale pass computed against
      correlationId: 'corr-test-0001',
      input,
      result: computed,
    });

    expect(outcome.skipped).toBe('stale-version');
    expect(handle.rows('space')[0]?.planVersion).toBe(1);
    expect(handle.rows('spaceItem')).toEqual([]);
    expect(completedPlans(handle)).toBe(0);
  });

  it('rolls the whole pass back when a write fails mid-transaction', async () => {
    const handle = createFakeDatabase((model, method) => {
      if (model === 'spaceItem' && method === 'upsert') {
        throw new Error('storage unavailable');
      }
    });
    seedProfile(handle);
    seedWorkingHours(handle);
    seedSpace(handle);
    seedTask(handle, { id: 'tsk-aaa-001', title: 'Doomed pass', spaceId: 'spc-plan-today' });
    const service = makeService(handle);

    await expect(service.planSpace({ userId: USER, date: DATE })).rejects.toMatchObject({
      code: 'PLANNING_FAILED',
    });

    expect(handle.rows('space')[0]?.planVersion).toBe(0);
    expect(handle.rows('spaceItem')).toEqual([]);
    expect(handle.rows('task')[0]?.scheduledStart).toBeNull();
    expect(handle.rows('eventLog').some((event) => event.eventType === 'PLANNING_FAILED')).toBe(
      true,
    );
    expect(completedPlans(handle)).toBe(0);
  });
});

describe('validation and dates', () => {
  it('rejects an invalid calendar date with INVALID_DATE', async () => {
    const handle = createFakeDatabase();
    seedProfile(handle);
    const service = makeService(handle);

    await expect(
      service.planSpace({ userId: USER, date: 'not-a-date' as CalendarDate }),
    ).rejects.toBeInstanceOf(PlanInvalidDateError);
    await expect(
      service.planSpace({ userId: USER, date: 'not-a-date' as CalendarDate }),
    ).rejects.toMatchObject({ code: 'INVALID_DATE' });
  });

  it('surfaces invalid planning data as PLAN_CONFLICT', async () => {
    const handle = createFakeDatabase();
    seedProfile(handle);
    seedSpace(handle);
    seedTask(handle, {
      id: 'tsk-aaa-001',
      title: 'Task in a broken week',
      spaceId: 'spc-plan-today',
    });
    handle.insert('workingHoursBlock', {
      userId: USER,
      weekday: 'MONDAY',
      startMinute: 780,
      endMinute: 540, // before start: structurally invalid
    });
    const service = makeService(handle);

    await expect(service.planSpace({ userId: USER, date: DATE })).rejects.toBeInstanceOf(
      PlanInputInvalidError,
    );
    await expect(service.planSpace({ userId: USER, date: DATE })).rejects.toMatchObject({
      code: 'PLANNING_CONFLICT',
    });
  });

  it('computes today in the user’s timezone', async () => {
    const lateInstant = '2026-03-30T23:30:00.000Z';

    const lisbon = createFakeDatabase();
    seedProfile(lisbon, { timeZone: 'Europe/Lisbon' });
    const lisbonToday = await makeService(lisbon, new FixedClock(lateInstant)).getToday(USER);
    expect(lisbonToday.date).toBe(asCalendarDate('2026-03-31'));

    const utc = createFakeDatabase();
    seedProfile(utc, { timeZone: 'UTC' });
    const utcToday = await makeService(utc, new FixedClock(lateInstant)).getToday(USER);
    expect(utcToday.date).toBe(asCalendarDate('2026-03-30'));
  });
});
