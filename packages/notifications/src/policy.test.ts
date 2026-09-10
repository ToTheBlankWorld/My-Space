import { asCalendarDate, asTimeZone } from '@space/time';
import { describe, expect, it } from 'vitest';

import {
  evaluateDailyBrief,
  evaluateDeadlineWarning,
  evaluatePlanCompletion,
  evaluateTaskMissed,
  type DailyCycleFacts,
  type UserNotificationSettings,
} from './policy';

const APP_URL = 'https://space.example.com';

const SETTINGS: UserNotificationSettings = {
  notificationsEnabled: true,
  emailNotificationsEnabled: true,
  timeZone: asTimeZone('UTC'),
  morningNotificationMinute: 420,
  middayNotificationMinute: 720,
  eveningNotificationMinute: 1080,
};

const FACTS: DailyCycleFacts = {
  userId: 'usr-test-0000000000001',
  today: asCalendarDate('2026-09-10'),
  tomorrowDate: asCalendarDate('2026-09-11'),
  tomorrowPlanned: true,
  openTaskCount: 4,
  scheduledTodayCount: 5,
  completedTodayCount: 2,
  deadlineCount: 1,
};

const atNoon = new Date('2026-09-10T12:00:00.000Z');

describe('evaluateDailyBrief', () => {
  it('produces a morning brief keyed to the user/day, NORMAL priority', () => {
    const draft = evaluateDailyBrief(
      SETTINGS,
      FACTS,
      { slot: 'morning', minute: 420, scheduledAt: atNoon },
      APP_URL,
    );

    expect(draft).not.toBeNull();
    expect(draft?.type).toBe('DAILY_PLAN');
    expect(draft?.priority).toBe('NORMAL');
    expect(draft?.deliveryKey).toBe('daily:morning:usr-test-0000000000001:2026-09-10');
    expect(draft?.linkUrl).toBe(`${APP_URL}/space/2026-09-10`);
    expect(draft?.title).toContain('4 tasks open');
    expect(draft?.email?.template).toBe('morning-brief');
  });

  it('calls out missing tomorrow in the evening brief with a stronger tone', () => {
    const draft = evaluateDailyBrief(
      SETTINGS,
      { ...FACTS, tomorrowPlanned: false },
      { slot: 'evening', minute: 1080, scheduledAt: atNoon },
      APP_URL,
    );

    expect(draft).not.toBeNull();
    expect(draft?.type).toBe('SCHEDULE_CHANGE');
    expect(draft?.priority).toBe('IMPORTANT');
    expect(draft?.email?.template).toBe('evening-planning');
  });

  it('stays silent when the master switch is off', () => {
    const draft = evaluateDailyBrief(
      { ...SETTINGS, notificationsEnabled: false },
      FACTS,
      { slot: 'morning', minute: 420, scheduledAt: atNoon },
      APP_URL,
    );

    expect(draft).toBeNull();
  });

  it('omits the email leg when email notifications are disabled', () => {
    const draft = evaluateDailyBrief(
      { ...SETTINGS, emailNotificationsEnabled: false },
      FACTS,
      { slot: 'midday', minute: 720, scheduledAt: atNoon },
      APP_URL,
    );

    expect(draft?.email).toBeUndefined();
    expect(draft?.deliveryKey).toBe('daily:midday:usr-test-0000000000001:2026-09-10');
  });
});

describe('evaluateDeadlineWarning', () => {
  it('is CRITICAL for a CRITICAL task, keyed by task + due date', () => {
    const draft = evaluateDeadlineWarning(
      SETTINGS,
      {
        taskId: 'tsk-1',
        title: 'Ship launch',
        dueAt: new Date('2026-09-10T16:00:00.000Z'),
        taskPriority: 'CRITICAL',
      },
      asTimeZone('UTC'),
      APP_URL,
    );

    expect(draft.priority).toBe('CRITICAL');
    expect(draft.type).toBe('DEADLINE_WARNING');
    expect(draft.deliveryKey).toBe('deadline:tsk-1:2026-09-10');
    expect(draft.email?.template).toBe('deadline-warning');
  });

  it('is IMPORTANT for a NORMAL task', () => {
    const draft = evaluateDeadlineWarning(
      SETTINGS,
      {
        taskId: 'tsk-2',
        title: 'File taxes',
        dueAt: new Date('2026-09-11T09:00:00.000Z'),
        taskPriority: 'NORMAL',
      },
      asTimeZone('UTC'),
      APP_URL,
    );

    expect(draft.priority).toBe('IMPORTANT');
    expect(draft.deliveryKey).toBe('deadline:tsk-2:2026-09-11');
    expect(draft.linkUrl).toBe(`${APP_URL}/space/2026-09-11`);
  });
});

describe('evaluateTaskMissed', () => {
  it('is a NORMAL, keyed notice for a slipped task', () => {
    const draft = evaluateTaskMissed(
      SETTINGS,
      { taskId: 'tsk-3', title: 'Prep notes', missedDate: asCalendarDate('2026-09-09') },
      APP_URL,
    );

    expect(draft.type).toBe('DEADLINE_WARNING');
    expect(draft.priority).toBe('NORMAL');
    expect(draft.deliveryKey).toBe('task-missed:tsk-3:2026-09-09');
    expect(draft.email?.template).toBe('task-missed');
  });
});

describe('evaluatePlanCompletion', () => {
  const base = {
    userId: 'usr-test-0000000000001',
    spaceId: 'spc-today',
    date: asCalendarDate('2026-09-10'),
    planVersion: 3,
    mode: 'applied' as const,
    applied: true,
    scheduled: 5,
    unscheduled: 0,
    conflicts: 0,
  };

  it('is silent when the plan did not meaningfully change', () => {
    const previous = { scheduled: 5, unscheduled: 0, conflicts: 0 };
    expect(evaluatePlanCompletion(SETTINGS, base, previous, APP_URL)).toBeNull();
  });

  it('emits an IMPORTANT draft when tasks went unplaced', () => {
    const draft = evaluatePlanCompletion(SETTINGS, { ...base, unscheduled: 2 }, null, APP_URL);

    expect(draft).not.toBeNull();
    expect(draft?.priority).toBe('IMPORTANT');
    expect(draft?.type).toBe('SCHEDULE_CHANGE');
    expect(draft?.deliveryKey).toBe('plan-change:spc-today:3');
  });

  it('emits an IMPORTANT draft when conflicts appeared after a clean plan', () => {
    const draft = evaluatePlanCompletion(
      SETTINGS,
      { ...base, conflicts: 1 },
      { scheduled: 5, unscheduled: 0, conflicts: 0 },
      APP_URL,
    );

    expect(draft?.priority).toBe('IMPORTANT');
  });

  it('is a NORMAL confirmation for a clean applied plan', () => {
    const draft = evaluatePlanCompletion(SETTINGS, base, null, APP_URL);

    expect(draft?.priority).toBe('NORMAL');
    expect(draft?.body).toContain('all placed cleanly');
  });

  it('is silent when notifications are disabled', () => {
    expect(
      evaluatePlanCompletion({ ...SETTINGS, notificationsEnabled: false }, base, null, APP_URL),
    ).toBeNull();
  });
});
