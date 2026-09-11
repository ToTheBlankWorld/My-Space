import type { Database } from '@space/database';
import type { Logger } from '@space/logger';
import {
  deliverQueuedEmail,
  finalizeFailedDelivery,
  RetryableDeliveryError,
  runSweep,
  type EmailProvider,
} from '@space/notifications';
import type { Clock } from '@space/time';
import { QUEUE_NAMES, QUEUE_PREFIX } from '@space/types';
import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import type { NotificationJobPayload, QueueDefinitions } from '.';
import { attachFailureLogging, WORKER_OPTIONS } from '.';

/**
 * Notification queue worker.
 *
 * Two job kinds arrive on the single `space:notifications` queue:
 *
 * - `sweep` — runs the full Stage 7 sweep (daily cycles, reminders, outbox
 *   consumption, delivery preparation) and fans out one `delivery` job per
 *   prepared email. The sweep itself is enqueued by the scheduler as one
 *   repeatable job (`space:notification-sweep`), so there is no per-user timer
 *   fan-out. The sweep is safe to retry: every write is idempotency-keyed and
 *   `enqueueDelivery` is de-duplicated by `jobId`.
 * - `delivery` — attempts one queued email. Idempotency is enforced by the
 *   terminal-email guard before any provider call; transient failures throw and
 *   let BullMQ back off; the final attempt dead-letters via `finalizeFailedDelivery`.
 */
export interface NotificationWorkerDeps {
  logger: Logger;
  connection: Redis;
  db: Database;
  clock: Clock;
  /** Public web base URL, used to build clickable links in emails. */
  appUrl: string;
  /** Null when AgentMail isn't configured: deliveries stay PENDING, never faked. */
  emailProvider: EmailProvider | null;
  /** Used to fan out delivery jobs from the sweep. */
  queues: Pick<QueueDefinitions, 'notifications'>;
}

export const createNotificationWorker = ({
  logger,
  connection,
  db,
  clock,
  appUrl,
  emailProvider,
  queues,
}: NotificationWorkerDeps): Worker => {
  const worker = new Worker<NotificationJobPayload>(
    QUEUE_NAMES.notifications,
    async (job: Job<NotificationJobPayload>) => {
      const jobLogger = logger.child({ jobId: job.id, queue: 'space:notifications' });
      const provider = emailProvider;

      if (job.data.kind === 'sweep') {
        const result = await runSweep({
          db,
          clock,
          logger: jobLogger,
          appUrl,
          emailProviderConfigured: provider !== null,
          enqueueDelivery: async (payload) => {
            if (provider === null) {
              // Safety net: prepareDeliveries already skips enqueueing when the
              // provider is unconfigured; never add a delivery job we cannot run.
              return;
            }
            await queues.notifications.add(
              'delivery',
              {
                kind: 'delivery',
                notificationId: payload.notificationId,
                emailLogId: payload.emailLogId,
              },
              { jobId: `delivery:${payload.emailLogId}` },
            );
          },
        });

        jobLogger.info(
          {
            dailyCreated: result.daily.created,
            remindersDispatched: result.reminders.dispatched,
            outboxEventsRead: result.outbox.eventsRead,
            outboxCreated: result.outbox.created,
            deliveriesPrepared: result.deliveries.prepared,
            providerUnconfigured: result.deliveries.providerUnconfigured,
          },
          'notification sweep completed',
        );
        return result;
      }

      const deliveryDeps = { db, clock, logger: jobLogger, appUrl, provider };
      try {
        const outcome = await deliverQueuedEmail(deliveryDeps, {
          notificationId: job.data.notificationId,
          emailLogId: job.data.emailLogId,
        });
        if (outcome.outcome === 'sent') {
          jobLogger.info(
            { notificationId: job.data.notificationId, emailLogId: job.data.emailLogId },
            'notification email sent',
          );
        }
        return outcome;
      } catch (error) {
        // The worker's retry/backoff handles transient failures; anything else
        // (including a final attempt's exhaustion) is handled in the `failed`
        // hook below.
        if (error instanceof RetryableDeliveryError) {
          jobLogger.warn({ code: error.code }, error.message);
        }
        throw error;
      }
    },
    {
      connection,
      prefix: QUEUE_PREFIX,
      concurrency: 3,
      limiter: {
        max: 20,
        duration: 60_000,
      },
      lockDuration: WORKER_OPTIONS.lockDuration,
      maxStalledCount: WORKER_OPTIONS.maxStalledCount,
    },
  );

  // Log every job that exhausts its retries, then run the delivery dead-letter
  // path below.
  attachFailureLogging(worker, logger);

  // Dead-letter path: after the last attempt of a delivery job fails, finalize
  // the notification (mark FAILED + audit) so the row never sits as 'QUEUED'
  // forever. Fire-and-forget: the job is already terminal, and the finalize
  // path swallows its own failures.
  worker.on('failed', (job, error) => {
    if (job === undefined || job.data.kind !== 'delivery') {
      return;
    }
    const attempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade < attempts) {
      return;
    }
    const notificationId = job.data.notificationId;
    void finalizeFailedDelivery(
      {
        db,
        clock,
        logger,
        appUrl,
        provider: emailProvider,
      },
      {
        notificationId,
        reason: error instanceof Error ? error.message.slice(0, 500) : 'delivery retries exhausted',
      },
    ).catch((failure: unknown) => {
      logger.error({ err: failure, notificationId }, 'finalizeFailedDelivery failed');
    });
  });

  return worker;
};
