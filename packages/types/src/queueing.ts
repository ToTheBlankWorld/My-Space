/**
 * Queue names for the PostgreSQL durable job queue.
 *
 * Both the worker (consumer) and the web app (producer) import these
 * constants so every queue is identified by the same name, and every
 * `BackgroundJob.queue` / `JobSchedule.queue` value comes from one place.
 */

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
 * Deterministic dedupe key for a single notification delivery: one pending
 * delivery job per email log row.
 */
export const deliveryJobId = (emailLogId: string): string => `delivery-${emailLogId}`;

// ---------------------------------------------------------------------------
// PostgreSQL queue identities (Redis removal migration)
// ---------------------------------------------------------------------------

/**
 * The `JobSchedule.scheduleKey` for one connection's periodic auto-sync.
 *
 * The single canonical identity for automatic synchronization: the web
 * application upserts the schedule row under this key when a connection is
 * established, and the worker's PostgreSQL scheduler claims due schedules by
 * the same key. The unique `scheduleKey` constraint is what prevents the web
 * and the worker from ever creating two independent auto-sync schedules.
 * (Identical to the BullMQ repeatable jobId, so a pre-migration deployment's
 * identities carry over conceptually.)
 */
export const autoSyncScheduleKey = (connectionId: string): string => `auto-sync-${connectionId}`;

/**
 * The `BackgroundJob.dedupeKey` for one manual sync request.
 *
 * Preserves the logical identity of the BullMQ jobId
 * `manual:{connectionId}:{calendarId|all}`: one pending/running manual sync
 * per connection+target, while a completed (or dead) one can always be
 * requested again via the enqueue's re-arm semantics.
 */
export const manualSyncDedupeKey = (connectionId: string, calendarId?: string): string =>
  `manual:${connectionId}:${calendarId ?? 'all'}`;
