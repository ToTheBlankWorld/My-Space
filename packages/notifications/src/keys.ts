/**
 * Stable, server-generated idempotency keys.
 *
 * Every notification that must not be created twice (daily briefs, plan-change
 * digests, deadline warnings, missed-task alerts, task reminders) gets a key
 * derived from the thing it describes. PostgreSQL guarantees uniqueness through
 * `notifications.deliveryKey`, so redelivered outbox batches, overlapping
 * workers and the periodic sweep reconcile are all safe by construction.
 *
 * Keys must stay stable across Stages — never change the format of an existing
 * key class without backfilling.
 */

export const DAILY_BRIEF_KEY = (slot: string, userId: string, date: string) =>
  `daily:${slot}:${userId}:${date}`;

export const PLAN_CHANGE_KEY = (spaceId: string, planVersion: string) =>
  `plan-change:${spaceId}:${planVersion}`;

export const DEADLINE_WARNING_KEY = (taskId: string, dueDate: string) =>
  `deadline:${taskId}:${dueDate}`;

export const TASK_MISSED_KEY = (taskId: string, missedDate: string) =>
  `task-missed:${taskId}:${missedDate}`;

export const REMINDER_KEY = (reminderId: string) => `reminder:${reminderId}`;

/** A reminder fires on the occurrence scheduling slot; today that is always 1. */
export const REMINDER_OCCURRENCE_KEY = (reminderId: string, occurrence: number) =>
  `reminder:${reminderId}:${occurrence}`;
