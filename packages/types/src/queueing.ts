/**
 * BullMQ queue namespace and names.
 *
 * Both the worker (consumers) and the web app (producers) import these
 * constants so every queue is identified by the same `name` + `prefix`
 * pair. BullMQ concatenates them into the qualified key namespace
 * `<prefix>:<name>` — e.g. `space:calendar-sync`.
 *
 * Colon characters in `name` are forbidden by BullMQ 5.81+; the namespace
 * lives in the `prefix` option instead.
 */

export const QUEUE_PREFIX = 'space';

export const QUEUE_NAMES = {
  calendarSync: 'calendar-sync',
  calendarRefresh: 'calendar-refresh',
  maintenance: 'maintenance',
  planning: 'planning',
  notifications: 'notifications',
  autonomyReview: 'autonomy-review',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
