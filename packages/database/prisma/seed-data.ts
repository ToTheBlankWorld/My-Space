import { addCalendarDays, instantAtLocalTime, toCalendarDate, type Clock } from '@space/time';
import type { CalendarDate } from '@space/types';

/**
 * Development seed data.
 *
 * Pure and deterministic: every identifier is fixed and every instant is derived
 * from the injected {@link Clock}, so two runs produce byte-identical data and
 * the seed can be asserted in a unit test without a database.
 *
 * The content is entirely fictional. No real person, address or credential
 * appears here, and nothing in this file is loaded outside development.
 */

/** The instant the seed treats as "now". Fixed so seeded data never drifts. */
export const SEED_INSTANT = '2026-03-30T09:00:00.000Z';

/**
 * Stable identifiers.
 *
 * Hand-written rather than generated: a re-run must update the same rows, and a
 * developer must be able to recognise seeded data at a glance.
 */
export const SEED_IDS = {
  users: {
    ada: 'seedusr00000000000000ada',
    noor: 'seedusr0000000000000noor',
  },
  goals: {
    shipStageThree: 'seedgoal000000000000ship',
  },
  spaces: {
    adaYesterday: 'seedspc00000000000ada001',
    adaToday: 'seedspc00000000000ada002',
    adaTomorrow: 'seedspc00000000000ada003',
    noorToday: 'seedspc0000000000noor001',
  },
  tasks: {
    adaMigrations: 'seedtsk00000000000ada001',
    adaReview: 'seedtsk00000000000ada002',
    adaDeadline: 'seedtsk00000000000ada003',
    adaMissed: 'seedtsk00000000000ada004',
    adaInbox: 'seedtsk00000000000ada005',
    noorSyllabus: 'seedtsk0000000000noor001',
  },
  reminders: {
    adaStandup: 'seedrmd00000000000ada001',
    adaWeekly: 'seedrmd00000000000ada002',
  },
  calendar: {
    connection: 'seedcon00000000000ada001',
    calendar: 'seedcal00000000000ada001',
    eventStandup: 'seedevt00000000000ada001',
    eventReview: 'seedevt00000000000ada002',
  },
  notifications: {
    adaPlan: 'seednot00000000000ada001',
    adaDeadline: 'seednot00000000000ada002',
  },
} as const;

const LISBON = 'Europe/Lisbon';
const KOLKATA = 'Asia/Kolkata';

export interface SeedUser {
  id: string;
  email: string;
  name: string;
  timeZone: string;
  locale: string;
}

export interface SeedSpace {
  id: string;
  userId: string;
  date: CalendarDate;
  timeZone: string;
  status: 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
  summary: string;
  planVersion: number;
  plannedAt: Date | null;
}

export interface SeedTask {
  id: string;
  userId: string;
  spaceId: string | null;
  goalId: string | null;
  title: string;
  description: string | null;
  priority: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';
  status:
    'INBOX' | 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'MISSED' | 'RESCHEDULED';
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  dueAt: Date | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  completedAt: Date | null;
}

export interface SeedData {
  now: Date;
  users: SeedUser[];
  preferences: {
    userId: string;
    timeZone: string;
    locale: string;
    morningNotificationMinute: number;
    middayNotificationMinute: number;
    eveningNotificationMinute: number;
  }[];
  planning: {
    userId: string;
    defaultTaskDurationMinutes: number;
    preferredPlanningMinute: number;
    schedulingStrategy: 'EARLIEST_FIT' | 'BALANCED' | 'DEADLINE_FIRST';
    autonomyLevel: 'SUGGEST_ONLY' | 'ASK_BEFORE_CHANGING' | 'AUTOMATICALLY_MANAGE';
    maxDailyFocusMinutes: number;
  }[];
  workingHours: {
    userId: string;
    weekday: 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY';
    startMinute: number;
    endMinute: number;
  }[];
  goals: {
    id: string;
    userId: string;
    title: string;
    description: string;
    status: 'ACTIVE';
    targetDate: CalendarDate;
  }[];
  spaces: SeedSpace[];
  tasks: SeedTask[];
  reminders: {
    id: string;
    userId: string;
    spaceId: string | null;
    title: string;
    remindAt: Date;
    timeZone: string;
    recurrenceFrequency: 'WEEKLY' | null;
    recurrenceInterval: number | null;
    recurrenceByWeekday: ('MONDAY' | 'FRIDAY')[];
  }[];
  calendarConnection: {
    id: string;
    userId: string;
    provider: 'GOOGLE';
    providerAccountId: string;
  };
  calendar: {
    id: string;
    userId: string;
    connectionId: string;
    externalId: string;
    name: string;
    timeZone: string;
    isPrimary: boolean;
  };
  calendarEvents: {
    id: string;
    userId: string;
    calendarId: string;
    spaceId: string;
    externalId: string;
    title: string;
    startAt: Date;
    endAt: Date;
    timeZone: string;
  }[];
  notifications: {
    id: string;
    userId: string;
    type: 'DAILY_PLAN' | 'DEADLINE_WARNING';
    priority: 'NORMAL' | 'IMPORTANT';
    title: string;
    body: string;
    readAt: Date | null;
  }[];
  productivity: {
    userId: string;
    date: CalendarDate;
    timeZone: string;
    tasksPlanned: number;
    tasksCompleted: number;
    tasksMissed: number;
    plannedMinutes: number;
    completedMinutes: number;
  }[];
}

const at = (date: CalendarDate, minuteOfDay: number, timeZone: string): Date =>
  instantAtLocalTime(date, minuteOfDay, timeZone);

const hours = (hour: number, minute = 0): number => hour * 60 + minute;

/**
 * Builds the seed graph for a given "now".
 *
 * Dates are computed in each user's own timezone: Noor's "today" is the calendar
 * date it is in Kolkata at this instant, which is not always the same day it is
 * in Lisbon. Seeding both from a single server-side date would quietly bake the
 * exact bug the timezone rules exist to prevent.
 */
export const buildSeedData = (clock: Clock): SeedData => {
  const now = clock.now();

  const adaToday = toCalendarDate(now, LISBON);
  const adaYesterday = addCalendarDays(adaToday, -1);
  const adaTomorrow = addCalendarDays(adaToday, 1);
  const noorToday = toCalendarDate(now, KOLKATA);

  const { users, goals, spaces, tasks, reminders, calendar, notifications } = SEED_IDS;

  return {
    now,

    users: [
      {
        id: users.ada,
        email: 'ada@example.test',
        name: 'Ada',
        timeZone: LISBON,
        locale: 'en',
      },
      {
        id: users.noor,
        email: 'noor@example.test',
        name: 'Noor',
        timeZone: KOLKATA,
        locale: 'en',
      },
    ],

    preferences: [
      {
        userId: users.ada,
        timeZone: LISBON,
        locale: 'en',
        morningNotificationMinute: hours(8),
        middayNotificationMinute: hours(13),
        eveningNotificationMinute: hours(19),
      },
      {
        userId: users.noor,
        timeZone: KOLKATA,
        locale: 'en',
        morningNotificationMinute: hours(7, 30),
        middayNotificationMinute: hours(12, 30),
        eveningNotificationMinute: hours(20),
      },
    ],

    planning: [
      {
        userId: users.ada,
        defaultTaskDurationMinutes: 45,
        preferredPlanningMinute: hours(8, 30),
        schedulingStrategy: 'DEADLINE_FIRST',
        autonomyLevel: 'ASK_BEFORE_CHANGING',
        maxDailyFocusMinutes: 300,
      },
      {
        userId: users.noor,
        defaultTaskDurationMinutes: 30,
        preferredPlanningMinute: hours(7, 45),
        schedulingStrategy: 'BALANCED',
        autonomyLevel: 'SUGGEST_ONLY',
        maxDailyFocusMinutes: 240,
      },
    ],

    workingHours: (['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] as const).flatMap(
      (weekday) => [
        { userId: users.ada, weekday, startMinute: hours(9), endMinute: hours(13) },
        { userId: users.ada, weekday, startMinute: hours(14), endMinute: hours(18) },
        { userId: users.noor, weekday, startMinute: hours(10), endMinute: hours(17) },
      ],
    ),

    goals: [
      {
        id: goals.shipStageThree,
        userId: users.ada,
        title: 'Ship the planning engine',
        description: 'Deterministic scheduling, end to end, with a replayable test suite.',
        status: 'ACTIVE',
        targetDate: addCalendarDays(adaToday, 60),
      },
    ],

    spaces: [
      {
        id: spaces.adaYesterday,
        userId: users.ada,
        date: adaYesterday,
        timeZone: LISBON,
        status: 'COMPLETED',
        summary: 'Closed out the migration work.',
        planVersion: 2,
        plannedAt: at(adaYesterday, hours(8, 30), LISBON),
      },
      {
        id: spaces.adaToday,
        userId: users.ada,
        date: adaToday,
        timeZone: LISBON,
        status: 'ACTIVE',
        summary: 'Deep work in the morning, review in the afternoon.',
        planVersion: 1,
        plannedAt: at(adaToday, hours(8, 30), LISBON),
      },
      {
        id: spaces.adaTomorrow,
        userId: users.ada,
        date: adaTomorrow,
        timeZone: LISBON,
        status: 'DRAFT',
        summary: 'Not planned yet.',
        planVersion: 0,
        plannedAt: null,
      },
      {
        id: spaces.noorToday,
        userId: users.noor,
        date: noorToday,
        timeZone: KOLKATA,
        status: 'ACTIVE',
        summary: 'Course preparation.',
        planVersion: 1,
        plannedAt: at(noorToday, hours(7, 45), KOLKATA),
      },
    ],

    tasks: [
      {
        id: tasks.adaMigrations,
        userId: users.ada,
        spaceId: spaces.adaYesterday,
        goalId: goals.shipStageThree,
        title: 'Write the initial migration',
        description: 'Schema, constraints and indexes.',
        priority: 'HIGH',
        status: 'COMPLETED',
        estimatedMinutes: 120,
        actualMinutes: 135,
        dueAt: at(adaYesterday, hours(18), LISBON),
        scheduledStart: at(adaYesterday, hours(9), LISBON),
        scheduledEnd: at(adaYesterday, hours(11), LISBON),
        completedAt: at(adaYesterday, hours(11, 15), LISBON),
      },
      {
        id: tasks.adaReview,
        userId: users.ada,
        spaceId: spaces.adaToday,
        goalId: goals.shipStageThree,
        title: 'Review the scheduling rules',
        description: 'Walk through the priority and conflict tables.',
        priority: 'NORMAL',
        status: 'PLANNED',
        estimatedMinutes: 60,
        actualMinutes: null,
        dueAt: null,
        scheduledStart: at(adaToday, hours(14), LISBON),
        scheduledEnd: at(adaToday, hours(15), LISBON),
        completedAt: null,
      },
      {
        id: tasks.adaDeadline,
        userId: users.ada,
        spaceId: spaces.adaToday,
        goalId: null,
        title: 'Submit the quarterly report',
        description: 'Hard deadline; cannot move.',
        priority: 'CRITICAL',
        status: 'IN_PROGRESS',
        estimatedMinutes: 90,
        actualMinutes: null,
        dueAt: at(adaToday, hours(17), LISBON),
        scheduledStart: at(adaToday, hours(9, 30), LISBON),
        scheduledEnd: at(adaToday, hours(11), LISBON),
        completedAt: null,
      },
      {
        id: tasks.adaMissed,
        userId: users.ada,
        spaceId: spaces.adaYesterday,
        goalId: null,
        title: 'Renew the domain',
        description: null,
        priority: 'LOW',
        status: 'MISSED',
        estimatedMinutes: 15,
        actualMinutes: null,
        dueAt: at(adaYesterday, hours(12), LISBON),
        scheduledStart: at(adaYesterday, hours(11, 30), LISBON),
        scheduledEnd: at(adaYesterday, hours(11, 45), LISBON),
        completedAt: null,
      },
      {
        id: tasks.adaInbox,
        userId: users.ada,
        spaceId: null,
        goalId: null,
        title: 'Read the PostgreSQL locking chapter',
        description: 'Not scheduled yet — lives in the inbox.',
        priority: 'LOW',
        status: 'INBOX',
        estimatedMinutes: 45,
        actualMinutes: null,
        dueAt: null,
        scheduledStart: null,
        scheduledEnd: null,
        completedAt: null,
      },
      {
        id: tasks.noorSyllabus,
        userId: users.noor,
        spaceId: spaces.noorToday,
        goalId: null,
        title: 'Draft the syllabus',
        description: null,
        priority: 'HIGH',
        status: 'PLANNED',
        estimatedMinutes: 90,
        actualMinutes: null,
        dueAt: at(addCalendarDays(noorToday, 2), hours(9), KOLKATA),
        scheduledStart: at(noorToday, hours(10), KOLKATA),
        scheduledEnd: at(noorToday, hours(11, 30), KOLKATA),
        completedAt: null,
      },
    ],

    reminders: [
      {
        id: reminders.adaStandup,
        userId: users.ada,
        spaceId: spaces.adaToday,
        title: 'Stand-up in 5 minutes',
        remindAt: at(adaToday, hours(9, 25), LISBON),
        timeZone: LISBON,
        recurrenceFrequency: null,
        recurrenceInterval: null,
        recurrenceByWeekday: [],
      },
      {
        id: reminders.adaWeekly,
        userId: users.ada,
        spaceId: null,
        title: 'Weekly review',
        remindAt: at(adaToday, hours(16), LISBON),
        timeZone: LISBON,
        recurrenceFrequency: 'WEEKLY',
        recurrenceInterval: 1,
        recurrenceByWeekday: ['FRIDAY'],
      },
    ],

    calendarConnection: {
      id: calendar.connection,
      userId: users.ada,
      provider: 'GOOGLE',
      providerAccountId: 'seed-google-account',
    },

    calendar: {
      id: calendar.calendar,
      userId: users.ada,
      connectionId: calendar.connection,
      externalId: 'seed-primary-calendar',
      name: 'Work',
      timeZone: LISBON,
      isPrimary: true,
    },

    calendarEvents: [
      {
        id: calendar.eventStandup,
        userId: users.ada,
        calendarId: calendar.calendar,
        spaceId: spaces.adaToday,
        externalId: 'seed-event-standup',
        title: 'Team stand-up',
        startAt: at(adaToday, hours(9, 30), LISBON),
        endAt: at(adaToday, hours(9, 45), LISBON),
        timeZone: LISBON,
      },
      {
        id: calendar.eventReview,
        userId: users.ada,
        calendarId: calendar.calendar,
        spaceId: spaces.adaToday,
        externalId: 'seed-event-review',
        title: 'Design review',
        startAt: at(adaToday, hours(15, 30), LISBON),
        endAt: at(adaToday, hours(16, 30), LISBON),
        timeZone: LISBON,
      },
    ],

    notifications: [
      {
        id: notifications.adaPlan,
        userId: users.ada,
        type: 'DAILY_PLAN',
        priority: 'NORMAL',
        title: 'Your day is ready',
        body: 'Three items are planned, one deadline is due at 17:00.',
        readAt: at(adaToday, hours(8, 35), LISBON),
      },
      {
        id: notifications.adaDeadline,
        userId: users.ada,
        type: 'DEADLINE_WARNING',
        priority: 'IMPORTANT',
        title: 'Quarterly report due today',
        body: 'The deadline is at 17:00 and 90 minutes of work remain.',
        readAt: null,
      },
    ],

    productivity: [
      {
        userId: users.ada,
        date: adaYesterday,
        timeZone: LISBON,
        tasksPlanned: 2,
        tasksCompleted: 1,
        tasksMissed: 1,
        plannedMinutes: 135,
        completedMinutes: 135,
      },
    ],
  };
};
