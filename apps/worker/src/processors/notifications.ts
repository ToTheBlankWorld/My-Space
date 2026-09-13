import type { Database } from '@space/database';
import type { Logger } from '@space/logger';
import {
  deliverQueuedEmail,
  RetryableDeliveryError,
  runSweep,
  type EmailProvider,
} from '@space/notifications';
import type { Clock } from '@space/time';

/**
 * The notification processor — the body of the PostgreSQL notification handler.
 *
 * Two job kinds arrive on the single `notifications` queue:
 *
 * - `sweep` — runs the full Stage 7 sweep (daily cycles, reminders, outbox
 *   consumption, delivery preparation) and fans out one `delivery` job per
 *   prepared email via the injected `enqueueDelivery`. The sweep is safe to
 *   retry: every write is idempotency-keyed and the enqueuer is deduplicated.
 * - `delivery` — attempts one queued email. Idempotency is enforced by the
 *   terminal-email guard in `deliverQueuedEmail` before any provider call
 *   (the primary correctness mechanism — job-level dedupe is only a cost
 *   optimisation on top). Transient failures throw `RetryableDeliveryError`
 *   and are retried by the owning queue; permanent failures are recorded by
 *   the service and return normally.
 *
 * The dead-letter hook (finalize-on-retries-exhausted) is caller-specific:
 * the PG handler runs it when the final attempt's error reaches it. The
 * processor itself just rethrows.
 */

export type NotificationJobPayload =
  | { kind: 'sweep' }
  | { kind: 'delivery'; notificationId: string; emailLogId: string };

export interface NotificationJobDeps {
  db: Database;
  clock: Clock;
  logger: Logger;
  /** Public web base URL, used to build clickable links in emails. */
  appUrl: string;
  /** Null when AgentMail isn't configured: deliveries stay PENDING, never faked. */
  emailProvider: EmailProvider | null;
  /** Adds one delivery job to the queue (a deduplicated `BackgroundJob`). */
  enqueueDelivery: (payload: {
    notificationId: string;
    emailLogId: string;
  }) => Promise<void>;
}

export const processNotificationJob = async (
  deps: NotificationJobDeps,
  payload: NotificationJobPayload,
): Promise<unknown> => {
  const { db, clock, logger, appUrl, emailProvider } = deps;

  if (payload.kind === 'sweep') {
    const jobLogger = logger.child({ queue: 'space:notifications' });
    const result = await runSweep({
      db,
      clock,
      logger: jobLogger,
      appUrl,
      emailProviderConfigured: emailProvider !== null,
      enqueueDelivery: async (prepared) => {
        if (emailProvider === null) {
          // Safety net: prepareDeliveries already skips enqueueing when the
          // provider is unconfigured; never add a delivery job we cannot run.
          return;
        }
        await deps.enqueueDelivery({
          notificationId: prepared.notificationId,
          emailLogId: prepared.emailLogId,
        });
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

  const jobLogger = logger.child({ queue: 'space:notifications' });
  try {
    const outcome = await deliverQueuedEmail(
      { db, clock, logger: jobLogger, appUrl, provider: emailProvider },
      { notificationId: payload.notificationId, emailLogId: payload.emailLogId },
    );
    if (outcome.outcome === 'sent') {
      jobLogger.info(
        { notificationId: payload.notificationId, emailLogId: payload.emailLogId },
        'notification email sent',
      );
    }
    return outcome;
  } catch (error) {
    // The owning queue's retry/backoff handles transient failures; anything
    // else (including a final attempt's exhaustion) is handled by the caller.
    if (error instanceof RetryableDeliveryError) {
      jobLogger.warn({ code: error.code }, error.message);
    }
    throw error;
  }
};
