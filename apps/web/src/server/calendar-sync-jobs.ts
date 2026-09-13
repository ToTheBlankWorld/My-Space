import { jobs as jobsStore, type Database } from '@space/database';
import {
  autoSyncScheduleKey,
  manualSyncDedupeKey,
  QUEUE_NAMES,
} from '@space/types';
import { z } from 'zod';

/**
 * The PostgreSQL calendar job producer — the web side of the durable queue.
 *
 * (The BullMQ/Redis producer this replaced lives only in migration history.)
 * A manual sync or a newly connected
 * calendar is a `BackgroundJob` row / a `JobSchedule` row in PostgreSQL, so
 * enqueueing needs nothing but the database the web app already has. The
 * Railway worker (PG runtime) materializes due schedules into jobs and
 * executes them; this module only ever *writes* queue state.
 *
 * Identity rules (shared with the worker via `@space/types`):
 *   - manual sync dedupe: `manual:{connectionId}:{calendarId|all}` — one
 *     pending/running manual sync per connection+target; completed/dead ones
 *     re-arm so "Sync now" always works again;
 *   - auto-sync schedule: `auto-sync-{connectionId}` — upserted by the web at
 *     connect time and re-anchored at worker boot; the unique schedule key
 *     makes double registration impossible.
 *
 * Job payloads are validated before insertion — no arbitrary objects enter
 * the durable queue. Job names: `manual-sync` (web-initiated, any trigger)
 * and `auto-sync` (schedule-materialised by the worker).
 */

/** Validated payload for every calendar sync job the web enqueues. */
export const calendarSyncJobPayloadSchema = z.object({
  userId: z.string().min(1),
  connectionId: z.string().min(1),
  /** Present: sync one calendar. Absent: sync every selected calendar. */
  calendarId: z.string().min(1).optional(),
  /** True: ignore the incremental sync cursor and fetch everything. */
  fullSync: z.boolean(),
});

export type CalendarSyncJobPayload = z.infer<typeof calendarSyncJobPayloadSchema>;

export interface ManualSyncInput {
  userId: string;
  connectionId: string;
  calendarId?: string;
  /** Defaults to false: an incremental manual sync. */
  fullSync?: boolean;
}

/**
 * Enqueues one manual calendar sync as a durable `BackgroundJob`.
 *
 * Deduplicated per connection+target with re-arm: a pending or running
 * equivalent request absorbs the click (no duplicate storms), while a
 * completed or dead one is re-armed into a fresh pending job — "Sync now"
 * must always be able to run again. Returns true when the queue accepted the
 * request (created, deduplicated or re-armed — all mean "accepted").
 */
export const enqueueCalendarSync = async (
  db: Database,
  input: ManualSyncInput,
  clock: { now: () => Date },
): Promise<boolean> => {
  const payload = calendarSyncJobPayloadSchema.parse({
    userId: input.userId,
    connectionId: input.connectionId,
    ...(input.calendarId !== undefined ? { calendarId: input.calendarId } : {}),
    fullSync: input.fullSync ?? false,
  });

  await jobsStore.enqueueDedupedJob(
    db,
    {
      queue: QUEUE_NAMES.calendarSync,
      name: 'manual-sync',
      payload,
      runAt: clock.now(),
      dedupeKey: manualSyncDedupeKey(input.connectionId, input.calendarId),
      // Retry budget and first backoff step.
      maxAttempts: 3,
      backoffBaseMs: 5_000,
    },
    // Re-arm terminal duplicates: a completed manual sync is a completed
    // request, not a permanent block on the next one.
    { rearm: true },
  );
  return true;
};

/**
 * Registers (or re-anchors) the periodic auto-sync schedule for a connection.
 *
 * A `JobSchedule` upsert — idempotent by its unique key, and the exact same
 * key the worker's scheduler ticks. The web never materializes or executes
 * the sync; it only makes sure the schedule row exists.
 */
export const scheduleCalendarAutoSync = async (
  db: Database,
  input: { userId: string; connectionId: string },
  clock: { now: () => Date },
  intervalMinutes: number = 15,
): Promise<boolean> => {
  await jobsStore.upsertJobSchedule(db, {
    scheduleKey: autoSyncScheduleKey(input.connectionId),
    queue: QUEUE_NAMES.calendarSync,
    name: 'auto-sync',
    payload: {
      userId: input.userId,
      connectionId: input.connectionId,
      fullSync: false,
    },
    everySeconds: Math.max(intervalMinutes, 1) * 60,
    nextRunAt: clock.now(),
  });
  return true;
};
