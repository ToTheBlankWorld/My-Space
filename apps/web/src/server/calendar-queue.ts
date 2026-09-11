import 'server-only';

import { createLogger, type Logger } from '@space/logger';
import { QUEUE_NAMES, QUEUE_PREFIX } from '@space/types';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * Manual sync enqueue helper for the web application.
 *
 * The heavy lifting lives in the worker process, which owns the queue consumers
 * and Redis connection. The web app only ever *adds* a job; when Redis is not
 * configured for the web (the default in local development), the route answers
 * 503 rather than pretending the work happened.
 */

const QUEUE_NAME = QUEUE_NAMES.calendarSync;

export interface CalendarSyncJobPayload {
  userId: string;
  connectionId: string;
  calendarId?: string;
  fullSync?: boolean;
}

const cache = globalThis as typeof globalThis & {
  __spaceCalendarQueue?: Queue<CalendarSyncJobPayload>;
  __spaceCalendarQueueLogger?: Logger;
};

const getLogger = (): Logger => {
  cache.__spaceCalendarQueueLogger ??= createLogger({
    name: 'space-web/calendar-sync',
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  });
  return cache.__spaceCalendarQueueLogger;
};

/** True when web-process Redis is configured and enqueueing is possible. */
export const calendarQueueAvailable = (): boolean =>
  Boolean(process.env.REDIS_URL) && Boolean(process.env.DATABASE_URL);

const getQueue = (): Queue<CalendarSyncJobPayload> | null => {
  if (!process.env.REDIS_URL) {
    return null;
  }

  if (!cache.__spaceCalendarQueue) {
    const connection = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    void connection.connect();

    cache.__spaceCalendarQueue = new Queue<CalendarSyncJobPayload>(QUEUE_NAME, {
      connection,
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86400 },
      },
    });
  }

  return cache.__spaceCalendarQueue;
};

/**
 * Enqueues a calendar sync job. Returns false when Redis is unavailable so the
 * caller can answer 503; the caller always verifies ownership first.
 */
export const enqueueCalendarSync = async (payload: CalendarSyncJobPayload): Promise<boolean> => {
  const queue = getQueue();

  if (!queue) {
    getLogger().warn({ connectionId: payload.connectionId }, 'sync requested but redis absent');
    return false;
  }

  try {
    getLogger().info({ connectionId: payload.connectionId }, 'manual sync enqueued');
    await queue.add('calendar-sync', payload, {
      jobId: `manual:${payload.connectionId}:${payload.calendarId ?? 'all'}`,
    });
    return true;
  } catch (error) {
    getLogger().error({ err: error, connectionId: payload.connectionId }, 'sync enqueue failed');
    return false;
  }
};

/**
 * Registers the periodic auto-sync for a connection.
 *
 * Idempotent: the deterministic `jobId` means BullMQ replaces an existing
 * repeatable job instead of stacking a second schedule. The worker ALSO
 * registers every CONNECTED connection at boot, so a connection that somehow
 * missed this call still gets periodic syncs after the next worker restart.
 */
export const scheduleCalendarAutoSync = async (payload: {
  userId: string;
  connectionId: string;
}): Promise<boolean> => {
  const queue = getQueue();

  if (!queue) {
    return false;
  }

  const intervalMinutes = Number(process.env.CALENDAR_SYNC_INTERVAL_MINUTES) || 15;

  try {
    getLogger().info({ connectionId: payload.connectionId }, 'auto-sync scheduled');
    await queue.add('auto-sync', payload, {
      repeat: { every: intervalMinutes * 60_000 },
      jobId: `auto-sync:${payload.connectionId}`,
    });
    return true;
  } catch (error) {
    getLogger().error(
      { err: error, connectionId: payload.connectionId },
      'auto-sync scheduling failed',
    );
    return false;
  }
};
