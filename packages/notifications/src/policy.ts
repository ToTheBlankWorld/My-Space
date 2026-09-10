import type { PlanMode } from '@space/planning';
import { toCalendarDate } from '@space/time';
import type { CalendarDate, TaskPriority, TimeZone } from '@space/types';

import { DAILY_BRIEF_KEY, DEADLINE_WARNING_KEY, PLAN_CHANGE_KEY, TASK_MISSED_KEY } from './keys';
import type { DailySlot, NotificationDraft } from './types';

/**
 * Deterministic notification policy. Pure functions only: no database access,
 * no clocks, no side effects.
 *
 * These functions decide *what deserves to be announced* and *how loudly*. They
 * never decide *when to run* — that belongs to the sweep, which owns the clock
 * and the timezone arithmetic. Every draft is a pure function of facts, so the
 * engine stays explainable and trivially testable.
 */

export interface UserNotificationSettings {
  notificationsEnabled: boolean;
  emailNotificationsEnabled: boolean;
  timeZone: TimeZone;
  morningNotificationMinute: number | null;
  middayNotificationMinute: number | null;
  eveningNotificationMinute: number | null;
}

export interface DailyCycleFacts {
  userId: string;
  /** The day the sweep is reconciling. */
  today: CalendarDate;
  tomorrowDate: CalendarDate;
  /** True when the user's tomorrow Space already has a plan (plannedAt set). */
  tomorrowPlanned: boolean;
  openTaskCount: number;
  scheduledTodayCount: number;
  completedTodayCount: number;
  deadlineCount: number;
}

export interface DailySlotInstant {
  slot: DailySlot;
  /** Wall-clock minute of day the brief should fire, per user preferences. */
  minute: number;
  /** The absolute instant the brief fires — chosen by the sweep, in the user's zone. */
  scheduledAt: Date;
}

/**
 * Safe in-app deep link to a day's space, or null when no day is known.
 * Links are the only places policy touches deployment config (`appUrl`).
 */
const spaceUrl = (appUrl: string, date: CalendarDate | null): string | null =>
  date === null ? null : `${appUrl}/space/${date}`;

const withEmail = (
  emailEnabled: boolean,
  template: NonNullable<NotificationDraft['email']>['template'],
  data: Record<string, unknown>,
): NotificationDraft['email'] | undefined => (emailEnabled ? { template, data } : undefined);

const dailyData = (facts: DailyCycleFacts): Record<string, unknown> => ({
  date: facts.today,
  tomorrowDate: facts.tomorrowDate,
  tomorrowPlanned: facts.tomorrowPlanned,
  openTaskCount: facts.openTaskCount,
  scheduledTodayCount: facts.scheduledTodayCount,
  completedTodayCount: facts.completedTodayCount,
  deadlineCount: facts.deadlineCount,
});

// ---------------------------------------------------------------------------
// Daily briefs
// ---------------------------------------------------------------------------

/**
 * The daily email cycle (Stage 7 parts 14-16).
 *
 * - morning: opens the day — what is open, what is on the calendar.
 * - midday:  a short pulse — how much of the day is already done.
 * - evening: when tomorrow is planned, reassure with a light recap; when it is
 *   not, lean in with a stronger prompt.
 */
export const evaluateDailyBrief = (
  settings: UserNotificationSettings,
  facts: DailyCycleFacts,
  slot: DailySlotInstant,
  appUrl: string,
): NotificationDraft | null => {
  if (!settings.notificationsEnabled) {
    return null;
  }

  const planUrl = spaceUrl(appUrl, facts.today);
  const data = { ...dailyData(facts), planUrl };

  const remaining = Math.max(0, facts.scheduledTodayCount - facts.completedTodayCount);
  const draft: Record<DailySlot, NotificationDraft> = {
    morning: {
      type: 'DAILY_PLAN',
      priority: 'NORMAL',
      title: `Good morning — ${facts.openTaskCount} task${facts.openTaskCount === 1 ? '' : 's'} open`,
      body: `${facts.openTaskCount} open, ${facts.scheduledTodayCount} on today's plan, ${facts.completedTodayCount} done.`,
      scheduledAt: slot.scheduledAt,
      deliveryKey: DAILY_BRIEF_KEY(slot.slot, facts.userId, facts.today),
      linkUrl: planUrl,
      email: withEmail(settings.emailNotificationsEnabled, 'morning-brief', data),
    },
    midday: {
      type: 'DAILY_PLAN',
      priority: 'NORMAL',
      title: `Midday — ${facts.completedTodayCount} done today`,
      body: `${facts.completedTodayCount} done, ${remaining} remaining on today's plan.`,
      scheduledAt: slot.scheduledAt,
      deliveryKey: DAILY_BRIEF_KEY(slot.slot, facts.userId, facts.today),
      linkUrl: planUrl,
      email: withEmail(settings.emailNotificationsEnabled, 'midday-pulse', data),
    },
    evening: {
      type: facts.tomorrowPlanned ? 'DAILY_PLAN' : 'SCHEDULE_CHANGE',
      priority: facts.tomorrowPlanned ? 'NORMAL' : 'IMPORTANT',
      title: facts.tomorrowPlanned
        ? 'Evening — tomorrow is planned'
        : 'Evening — nothing planned for tomorrow yet',
      body: facts.tomorrowPlanned
        ? `${facts.tomorrowDate} has a plan. You're set for the morning.`
        : `Plan ${facts.tomorrowDate} before tomorrow starts, so the morning brief has a shape to work with.`,
      scheduledAt: slot.scheduledAt,
      deliveryKey: DAILY_BRIEF_KEY(slot.slot, facts.userId, facts.today),
      linkUrl: planUrl,
      email: withEmail(settings.emailNotificationsEnabled, 'evening-planning', data),
    },
  };

  return draft[slot.slot];
};

// ---------------------------------------------------------------------------
// Deadline warnings
// ---------------------------------------------------------------------------

export interface DeadlineCandidate {
  taskId: string;
  title: string;
  /** Absolute instant the task is due. */
  dueAt: Date;
  taskPriority: TaskPriority;
}

/**
 * A deadline drawing near (Stage 7 part 8).
 *
 * One impression per task, keyed by the calendar date the deadline falls on in
 * the user's zone, so a task re-planned within the same day never re-warns.
 */
export const evaluateDeadlineWarning = (
  settings: UserNotificationSettings,
  candidate: DeadlineCandidate,
  timeZone: TimeZone,
  appUrl: string,
): NotificationDraft => {
  const dueDate = toCalendarDate(candidate.dueAt, timeZone);
  const urgent = candidate.taskPriority === 'CRITICAL';

  return {
    type: 'DEADLINE_WARNING',
    priority: urgent ? 'CRITICAL' : 'IMPORTANT',
    title: `Deadline today — ${candidate.title}`,
    body: `"${candidate.title}" is due ${dueDate}${urgent ? ' and it is a CRITICAL priority' : ''}.`,
    scheduledAt: null,
    deliveryKey: DEADLINE_WARNING_KEY(candidate.taskId, dueDate),
    linkUrl: spaceUrl(appUrl, dueDate),
    email: withEmail(settings.emailNotificationsEnabled, 'deadline-warning', {
      taskId: candidate.taskId,
      title: candidate.title,
      dueDate,
      dueAt: candidate.dueAt.toISOString(),
      taskPriority: candidate.taskPriority,
    }),
  };
};

// ---------------------------------------------------------------------------
// Missed tasks
// ---------------------------------------------------------------------------

export interface MissedTaskCandidate {
  taskId: string;
  title: string;
  /** The day the task slipped past. */
  missedDate: CalendarDate;
}

/**
 * A task that did not happen on the day it was scheduled (Stage 7 part 9).
 * `NORMAL`: the next-day review is the primary authority on rescheduling.
 */
export const evaluateTaskMissed = (
  settings: UserNotificationSettings,
  candidate: MissedTaskCandidate,
  appUrl: string,
): NotificationDraft => ({
  type: 'DEADLINE_WARNING',
  priority: 'NORMAL',
  title: `Missed today — ${candidate.title}`,
  body: `"${candidate.title}" was scheduled for ${candidate.missedDate} and did not happen.`,
  scheduledAt: null,
  deliveryKey: TASK_MISSED_KEY(candidate.taskId, candidate.missedDate),
  linkUrl: spaceUrl(appUrl, candidate.missedDate),
  email: withEmail(settings.emailNotificationsEnabled, 'task-missed', {
    taskId: candidate.taskId,
    title: candidate.title,
    missedDate: candidate.missedDate,
  }),
});

// ---------------------------------------------------------------------------
// Plan completion
// ---------------------------------------------------------------------------

export interface PlanCompletionFacts {
  userId: string;
  spaceId: string;
  date: CalendarDate;
  planVersion: number;
  mode: PlanMode;
  /** Whether the pass actually moved items (false under suggest-only). */
  applied: boolean;
  scheduled: number;
  unscheduled: number;
  conflicts: number;
}

export interface PreviousPlanSummary {
  scheduled: number;
  unscheduled: number;
  conflicts: number;
}

/**
 * A planning pass finished (Stage 7 part 10, outbox policy).
 *
 * The key is the space + planVersion, making a replay of the same event a
 * no-op. Only a *meaningful* change produces a draft — a refresh that changed
 * nothing is silent. Unplaced tasks or conflicts make the tone IMPORTANT; a
 * clean applied plan is a NORMAL confirmation.
 */
export const evaluatePlanCompletion = (
  settings: UserNotificationSettings,
  facts: PlanCompletionFacts,
  previous: PreviousPlanSummary | null,
  appUrl: string,
): NotificationDraft | null => {
  if (!settings.notificationsEnabled) {
    return null;
  }

  const changed =
    previous === null ||
    previous.scheduled !== facts.scheduled ||
    previous.unscheduled !== facts.unscheduled ||
    previous.conflicts !== facts.conflicts;
  if (!changed) {
    return null;
  }

  const notable = facts.unscheduled > 0 || facts.conflicts > 0;

  return {
    type: 'SCHEDULE_CHANGE',
    priority: notable ? 'IMPORTANT' : 'NORMAL',
    title: notable ? `Plan for ${facts.date} needs attention` : `Plan for ${facts.date} updated`,
    body: notable
      ? `${facts.unscheduled} task${facts.unscheduled === 1 ? ' was' : 's were'} not placed and ${facts.conflicts} conflict${facts.conflicts === 1 ? ' was' : 's were'} found.`
      : `Planned ${facts.scheduled} item${facts.scheduled === 1 ? '' : 's'} for ${facts.date}, all placed cleanly.`,
    scheduledAt: null,
    deliveryKey: PLAN_CHANGE_KEY(facts.spaceId, String(facts.planVersion)),
    linkUrl: spaceUrl(appUrl, facts.date),
    email: withEmail(settings.emailNotificationsEnabled, 'plan-changed', {
      spaceId: facts.spaceId,
      date: facts.date,
      planVersion: facts.planVersion,
      mode: facts.mode,
      applied: facts.applied,
      scheduled: facts.scheduled,
      unscheduled: facts.unscheduled,
      conflicts: facts.conflicts,
    }),
  };
};
