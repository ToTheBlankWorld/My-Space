import type { ClassifiedChange, ChangeClassification, ChangeReasonCode } from './types';

/**
 * Deterministic change classification.
 *
 * Every domain event the loop might observe maps to exactly one classification
 * and one stable reason code. The mapping is total: an event type this module
 * has never seen classifies as NO_REPLAN rather than throwing, so a newer
 * producer can never break an older loop (the same forward-compatibility rule
 * the event log itself promises).
 *
 * This module is pure — it never touches the database or a clock — so the same
 * event always classifies the same way.
 */

/** How far ahead the loop cares about calendar/task changes, in calendar days. */
export const IMPACT_HORIZON_DAYS = 3;

const RATIONALE: Record<ChangeReasonCode, string> = {
  CALENDAR_CHANGED:
    'A calendar sync changed events on the day; the anchors the plan schedules around moved.',
  DEADLINE_IMPENDING: 'An open task has a deadline approaching but no placement that meets it yet.',
  DEADLINE_IMPOSSIBLE:
    'An open task is due today and can no longer be placed to meet its deadline.',
  DEADLINE_ELAPSED: "An open task's deadline has already passed.",
  TASK_CHANGED:
    'A task that belongs to a planned or upcoming day changed; its placement may be stale.',
  TASK_COMPLETED: 'A task on a planned day was completed; the freed window can be reused.',
  TASK_MISSED_ELAPSED: 'A scheduled block elapsed without the task being completed.',
  TASK_OVERDUE: 'An open task is past its deadline.',
  PLANNING_COMPLETED: 'A planning pass finished; the plan it produced is the current truth.',
  TOMORROW_UNPLANNED: "Tomorrow is not planned yet and the user's schedule is ready for it.",
  REVIEW_ONLY: 'The change does not invalidate a plan but is worth auditing.',
  NO_CHANGE: 'The change does not affect any day, or the event cannot be acted on.',
};

const REVIEWED: readonly { eventType: string; reasonCode: ChangeReasonCode }[] = [
  { eventType: 'CALENDAR_CONNECTED', reasonCode: 'REVIEW_ONLY' },
  { eventType: 'CALENDAR_DISCONNECTED', reasonCode: 'REVIEW_ONLY' },
  { eventType: 'CALENDAR_SYNC_FAILED', reasonCode: 'REVIEW_ONLY' },
  { eventType: 'PLANNING_FAILED', reasonCode: 'REVIEW_ONLY' },
  { eventType: 'TASK_MISSED', reasonCode: 'REVIEW_ONLY' },
  { eventType: 'REMINDER_CREATED', reasonCode: 'REVIEW_ONLY' },
  { eventType: 'REMINDER_TRIGGERED', reasonCode: 'REVIEW_ONLY' },
];

const NO_CHANGE: readonly string[] = [
  'PLANNING_COMPLETED',
  'PLANNING_STARTED',
  'DEADLINE_APPROACHING',
  'NOTIFICATION_CREATED',
  'NOTIFICATION_QUEUED',
  'NOTIFICATION_SENT',
  'NOTIFICATION_FAILED',
  'GOAL_CREATED',
  'GOAL_ACHIEVED',
  'SPACE_CREATED',
  'SPACE_UPDATED',
  'SPACE_OPTIMIZED',
  'REMINDER_SKIPPED',
];

const REPLAN: readonly { eventType: string; reasonCode: ChangeReasonCode }[] = [
  { eventType: 'CALENDAR_CHANGED', reasonCode: 'CALENDAR_CHANGED' },
  { eventType: 'CALENDAR_SYNCED', reasonCode: 'CALENDAR_CHANGED' },
  { eventType: 'TASK_CREATED', reasonCode: 'TASK_CHANGED' },
  { eventType: 'TASK_UPDATED', reasonCode: 'TASK_CHANGED' },
  { eventType: 'TASK_RESCHEDULED', reasonCode: 'TASK_CHANGED' },
  { eventType: 'TASK_COMPLETED', reasonCode: 'TASK_COMPLETED' },
];

/** Classifies one observed event type. */
export const classifyChange = (eventType: string): ClassifiedChange => {
  const replan = REPLAN.find((row) => row.eventType === eventType);
  if (replan) {
    return {
      eventType,
      classification: 'REPLAN_REQUIRED',
      reasonCode: replan.reasonCode,
      rationale: RATIONALE[replan.reasonCode],
    };
  }

  const reviewed = REVIEWED.find((row) => row.eventType === eventType);
  if (reviewed) {
    return {
      eventType,
      classification: 'REVIEW_ONLY',
      reasonCode: reviewed.reasonCode,
      rationale: RATIONALE[reviewed.reasonCode],
    };
  }

  if (NO_CHANGE.includes(eventType)) {
    return {
      eventType,
      classification: 'NO_REPLAN',
      reasonCode: 'NO_CHANGE',
      rationale: RATIONALE.NO_CHANGE,
    };
  }

  return {
    eventType,
    classification: 'NO_REPLAN',
    reasonCode: 'NO_CHANGE',
    rationale: RATIONALE.NO_CHANGE,
  };
};

export const classificationRank: Record<ChangeClassification, number> = {
  NO_REPLAN: 0,
  REVIEW_ONLY: 1,
  REPLAN_REQUIRED: 2,
  URGENT_REPLAN: 3,
};

/** True when `a` is at least as loud as `b`. */
export const atLeast = (a: ChangeClassification, b: ChangeClassification): boolean =>
  classificationRank[a] >= classificationRank[b];
