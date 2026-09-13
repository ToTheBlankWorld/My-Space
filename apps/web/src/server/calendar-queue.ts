import 'server-only';

import type { Database } from '@space/database';

import {
  enqueueCalendarSync as enqueueCalendarSyncJob,
  scheduleCalendarAutoSync as scheduleAutoSyncJob,
  type ManualSyncInput,
} from './calendar-sync-jobs';
import { clock as webClock } from './clock';

/**
 * Server-side calendar queue access for the web application.
 *
 * The heavy lifting lives in the worker process, which owns the job
 * consumers. The web app only ever *writes* durable queue state — a
 * `BackgroundJob` row for a manual sync, a `JobSchedule` row for the
 * periodic auto-sync — so enqueueing requires nothing but the database the
 * web app already has. Redis/BullMQ plays no part on this side any more.
 *
 * This module is the composition root: it binds the validated job builders
 * (`calendar-sync-jobs.ts`, unit-testable) to the web's database handle and
 * the deployment's configuration.
 */

export type { ManualSyncInput };

/**
 * True when the web can enqueue calendar work: it needs only the database.
 * Kept as an explicit seam so callers can answer honestly if persistence is
 * ever unconfigured (local dev without a database).
 */
export const calendarQueueAvailable = (): boolean => Boolean(process.env.DATABASE_URL);

/** The deployment's auto-sync cadence, in minutes (minimum 1, default 15). */
const autoSyncIntervalMinutes = (): number => {
  const raw = Number(process.env.CALENDAR_SYNC_INTERVAL_MINUTES);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 15;
};

/**
 * Enqueues one manual calendar sync (`BackgroundJob`). Returns true when the
 * queue accepted the request; throws only on a database failure, which the
 * routes surface as a 503 — "not available right now", never "done".
 */
export const enqueueCalendarSync = async (
  db: Database,
  input: ManualSyncInput,
): Promise<boolean> => enqueueCalendarSyncJob(db, input, webClock);

/**
 * Registers (or re-anchors) the periodic auto-sync `JobSchedule` for a
 * connection, using the deployment's configured interval. Idempotent by the
 * shared schedule key; the worker is the sole materializer of due schedules.
 */
export const scheduleCalendarAutoSync = async (
  db: Database,
  input: { userId: string; connectionId: string },
): Promise<boolean> => scheduleAutoSyncJob(db, input, webClock, autoSyncIntervalMinutes());
