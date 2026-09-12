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

/**
 * Deterministic, BullMQ-5.81-safe job id for a single notification delivery.
 *
 * Custom job ids must not contain `:` unless they carry exactly three
 * colon-separated segments (BullMQ's legacy repeatable-job form); a plain
 * `delivery:<emailLogId>` failed validation with "Custom Id cannot contain :".
 * The colon-free form keeps de-duplication per email log while satisfying
 * BullMQ's validation.
 */
export const deliveryJobId = (emailLogId: string): string => `delivery-${emailLogId}`;

/**
 * Deterministic, BullMQ-5.81-safe job id for one connection's periodic
 * calendar auto-sync. Colon-free so BullMQ accepts it while BullMQ still
 * de-duplicates the schedule per connection.
 */
export const autoSyncJobId = (connectionId: string): string => `auto-sync-${connectionId}`;
