import type { Database } from '@space/database';
import { jobs as jobsStore } from '@space/database';
import type { Keyring } from '@space/auth';
import type { GoogleClientCredentials } from '@space/calendar';
import { finalizeFailedDelivery, type EmailProvider } from '@space/notifications';
import type { Gauge } from '@space/metrics';
import type { Logger } from '@space/logger';
import { deliveryJobId, QUEUE_NAMES } from '@space/types';
import type { Clock } from '@space/time';

import { processAutonomyReviewJob } from '../../processors/autonomy';
import { processCalendarSyncJob } from '../../processors/calendar-sync';
import { createDatabaseConnectionSyncLock } from '../../processors/db-sync-lock';
import type { MaintenanceRetentionConfig } from '../../processors/maintenance';
import { processMaintenanceJob } from '../../processors/maintenance';
import { processNotificationJob } from '../../processors/notifications';
import { processPlanningJob } from '../../processors/planning';
import { createPacer, type Pacer } from './pacer';
import { PermanentJobError, type PgJobContext, type PgJobHandler, type PgQueueClass } from './runtime';

/**
 * PostgreSQL handlers for the five migrated processor families.
 *
 * Each handler is a thin adapter: validate the job payload, pace it against
 * the queue's third-party budget, then run the processor body. Nothing here
 * re-implements domain logic.
 *
 * Error semantics:
 *  - transient errors rethrow → the runtime's `failJob` reschedules with
 *    backoff until the retry budget is exhausted, then DEAD;
 *  - permanent domain failures (auth/permission, invalid planning input,
 *    permanent provider errors) are recorded by the processors and return
 *    normally — the job completes, no retry is spent;
 *  - a malformed payload is a programmer error, not a transient condition —
 *    it dead-letters immediately via `PermanentJobError`.
 *
 * Rate pacing is in-process (see `./pacer`): the budgets are fixed windows
 * that assume the current single-worker deployment.
 */

/** Per-queue enqueue defaults: retry budget and first backoff step. */
export const QUEUE_JOB_DEFAULTS: Record<string, { maxAttempts: number; backoffBaseMs: number }> = {
  [QUEUE_NAMES.calendarSync]: { maxAttempts: 3, backoffBaseMs: 5_000 },
  [QUEUE_NAMES.planning]: { maxAttempts: 2, backoffBaseMs: 10_000 },
  [QUEUE_NAMES.notifications]: { maxAttempts: 3, backoffBaseMs: 10_000 },
  [QUEUE_NAMES.autonomyReview]: { maxAttempts: 2, backoffBaseMs: 5_000 },
  [QUEUE_NAMES.maintenance]: { maxAttempts: 1, backoffBaseMs: 10_000 },
};

export interface PgHandlersDeps {
  db: Database;
  clock: Clock;
  logger: Logger;
  appUrl: string;
  /** Null when AgentMail isn't configured: deliveries stay PENDING, never faked. */
  emailProvider: EmailProvider | null;
  maxTasksPerPlan: number;
  retention: MaintenanceRetentionConfig;
  /** Created once per process by the bootstrap. */
  prunedRows?: Gauge;
  /** Present only when Google OAuth + the token keyring are configured;
   * without them the calendar-sync family is not registered at all. */
  calendar?: { keyring: Keyring; google: GoogleClientCredentials };
}

export interface PgHandlerSet {
  handlers: Record<string, PgJobHandler>;
  /** Concurrency per queue. */
  classes: PgQueueClass[];
}

// ---------------------------------------------------------------------------
// Payload validation — malformed payloads dead-letter, never retry
// ---------------------------------------------------------------------------

const asObject = (context: PgJobContext): Record<string, unknown> => {
  const payload = context.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PermanentJobError(`job ${context.jobId} payload is not an object`);
  }
  return payload;
};

const requireString = (
  payload: Record<string, unknown>,
  field: string,
  context: PgJobContext,
): string => {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PermanentJobError(
      `job ${context.jobId} payload field "${field}" must be a non-empty string`,
    );
  }
  return value;
};

const requireNumber = (
  payload: Record<string, unknown>,
  field: string,
  context: PgJobContext,
): number => {
  const value = payload[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PermanentJobError(`job ${context.jobId} payload field "${field}" must be a number`);
  }
  return value;
};

const optionalString = (payload: Record<string, unknown>, field: string): string | undefined => {
  const value = payload[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const optionalBoolean = (payload: Record<string, unknown>, field: string): boolean | undefined => {
  const value = payload[field];
  return typeof value === 'boolean' ? value : undefined;
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const createPgHandlers = (deps: PgHandlersDeps): PgHandlerSet => {
  const { db, clock, logger, appUrl, emailProvider } = deps;

  const pacers: Record<string, Pacer> = {
    // Per-window budgets for third-party APIs and CPU-heavy passes.
    // Process-local by design (single-worker deployment).
    [QUEUE_NAMES.calendarSync]: createPacer({ max: 10, windowMs: 60_000 }),
    [QUEUE_NAMES.planning]: createPacer({ max: 10, windowMs: 60_000 }),
    [QUEUE_NAMES.notifications]: createPacer({ max: 20, windowMs: 60_000 }),
    [QUEUE_NAMES.autonomyReview]: createPacer({ max: 2, windowMs: 120_000 }),
  };

  const notificationJobDeps = (context: PgJobContext) => ({
    db,
    clock,
    logger: logger.child({ jobId: context.jobId }),
    appUrl,
    emailProvider,
    enqueueDelivery: async (prepared: { notificationId: string; emailLogId: string }) => {
      if (emailProvider === null) {
        // Safety net: prepareDeliveries already skips enqueueing when the
        // provider is unconfigured; never add a delivery job we cannot run.
        return;
      }
      // Job-level dedupe on the email log id. The delivery processor's
      // terminal-email guard remains the
      // primary idempotency mechanism; this only avoids duplicate queue rows.
      await jobsStore.enqueueDedupedJob(db, {
        queue: QUEUE_NAMES.notifications,
        name: 'delivery',
        payload: { kind: 'delivery', ...prepared },
        runAt: clock.now(),
        dedupeKey: deliveryJobId(prepared.emailLogId),
        maxAttempts: QUEUE_JOB_DEFAULTS[QUEUE_NAMES.notifications]!.maxAttempts,
        backoffBaseMs: QUEUE_JOB_DEFAULTS[QUEUE_NAMES.notifications]!.backoffBaseMs,
      });
    },
  });

  const handlers: Record<string, PgJobHandler> = {
    [QUEUE_NAMES.planning]: async (context) => {
      await pacers[QUEUE_NAMES.planning]!.take();
      const payload = asObject(context);
      await processPlanningJob(
        {
          db,
          clock,
          logger: logger.child({ jobId: context.jobId }),
          maxTasksPerPlan: deps.maxTasksPerPlan,
        },
        {
          userId: requireString(payload, 'userId', context),
          date: requireString(payload, 'date', context),
          spaceId: requireString(payload, 'spaceId', context),
          planVersion: requireNumber(payload, 'planVersion', context),
          trigger: optionalString(payload, 'trigger') as 'user' | 'autonomous' | undefined,
        },
      );
    },

    [QUEUE_NAMES.notifications]: async (context) => {
      await pacers[QUEUE_NAMES.notifications]!.take();
      const payload = asObject(context);

      if (context.name === 'sweep') {
        await processNotificationJob(notificationJobDeps(context), { kind: 'sweep' });
        return;
      }
      if (context.name === 'delivery') {
        const delivery = {
          notificationId: requireString(payload, 'notificationId', context),
          emailLogId: requireString(payload, 'emailLogId', context),
        };
        try {
          await processNotificationJob(notificationJobDeps(context), {
            kind: 'delivery',
            ...delivery,
          });
          return;
        } catch (error) {
          // Dead-letter domain hook: on the final attempt's failure, finalize
          // the notification so it never sits as QUEUED; the job itself
          // still goes DEAD.
          if (context.attempts >= context.maxAttempts) {
            await finalizeFailedDelivery(
              {
                db,
                clock,
                logger: logger.child({ jobId: context.jobId }),
                appUrl,
                provider: emailProvider,
              },
              {
                notificationId: delivery.notificationId,
                reason:
                  error instanceof Error
                    ? error.message.slice(0, 500)
                    : 'delivery retries exhausted',
              },
            ).catch((failure: unknown) => {
              logger.error(
                { err: failure, notificationId: delivery.notificationId },
                'finalizeFailedDelivery failed',
              );
            });
          }
          throw error;
        }
      }
      throw new PermanentJobError(`unknown notification job name "${context.name}"`);
    },

    [QUEUE_NAMES.autonomyReview]: async (context) => {
      await pacers[QUEUE_NAMES.autonomyReview]!.take();
      if (context.name !== 'review') {
        throw new PermanentJobError(`unknown autonomy-review job name "${context.name}"`);
      }
      await processAutonomyReviewJob({
        db,
        clock,
        logger: logger.child({ jobId: context.jobId }),
        appUrl,
        enqueueReplan: async (request) => {
          // Replan coalescing: a dedupeKey upsert keyed `space:replan:{spaceId}`.
          // A PENDING replan is
          // replaced (newer planVersion, fresh runAt); a RUNNING one is never
          // overwritten; terminal ones are not resurrected. The planVersion
          // CAS in the planning processor remains the final correctness guard.
          const defaults = QUEUE_JOB_DEFAULTS[QUEUE_NAMES.planning]!;
          await jobsStore.coalesceJob(db, {
            queue: QUEUE_NAMES.planning,
            name: 'autonomous-replan',
            payload: {
              userId: request.userId,
              spaceId: request.spaceId,
              date: request.date,
              planVersion: request.planVersion,
              trigger: 'autonomous',
            },
            runAt: clock.now(),
            dedupeKey: `space:replan:${request.spaceId}`,
            maxAttempts: defaults.maxAttempts,
            backoffBaseMs: defaults.backoffBaseMs,
          });
        },
      });
    },

    [QUEUE_NAMES.maintenance]: async (context) => {
      if (context.name !== 'prune-retained-data') {
        throw new PermanentJobError(`unknown maintenance job name "${context.name}"`);
      }
      await processMaintenanceJob(
        {
          db,
          clock,
          logger: logger.child({ jobId: context.jobId }),
          retention: deps.retention,
          prunedRows: deps.prunedRows,
        },
        { task: 'prune-retained-data' },
      );
      // Durable-queue retention: terminal job rows age out after one day
      // (completed) and one week (dead/cancelled). PENDING/RUNNING rows are
      // structurally excluded by their status predicate.
      await jobsStore.pruneTerminalJobs(db, {
        completedOlderThan: new Date(clock.now().getTime() - 24 * 60 * 60 * 1000),
        terminalOlderThan: new Date(clock.now().getTime() - 7 * 24 * 60 * 60 * 1000),
      });
    },
  };

  const classes: PgQueueClass[] = [
    { queue: QUEUE_NAMES.planning, concurrency: 2 },
    { queue: QUEUE_NAMES.notifications, concurrency: 3 },
    { queue: QUEUE_NAMES.autonomyReview, concurrency: 1 },
    { queue: QUEUE_NAMES.maintenance, concurrency: 1 },
  ];

  if (deps.calendar !== undefined) {
    const { keyring, google } = deps.calendar;
    handlers[QUEUE_NAMES.calendarSync] = async (context) => {
      await pacers[QUEUE_NAMES.calendarSync]!.take();
      const raw = asObject(context);
      const payload = {
        userId: requireString(raw, 'userId', context),
        connectionId: requireString(raw, 'connectionId', context),
        calendarId: optionalString(raw, 'calendarId'),
        fullSync: optionalBoolean(raw, 'fullSync'),
      };
      await processCalendarSyncJob(
        {
          db,
          clock,
          keyring,
          google,
          logger: logger.child({ jobId: context.jobId }),
          lease: createDatabaseConnectionSyncLock(db, payload.connectionId),
        },
        payload,
      );
    };
    classes.unshift({ queue: QUEUE_NAMES.calendarSync, concurrency: 2 });
  } else {
    logger.warn('pg calendar-sync handler disabled: google or keyring configuration missing');
  }

  return { handlers, classes };
};
