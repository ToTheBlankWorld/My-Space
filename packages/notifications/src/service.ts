import { audit, delivery } from '@space/database';

import { renderEmail } from './templates';
import { TEMPLATE_NAMES } from './types';
import { type EmailProvider } from './provider';
import { runSweep, type SweepDeps, type SweepResult } from './sweep';

/**
 * The notification service: sweep orchestration plus the delivery worker's core
 * — everything except the queue plumbing, which lives in the worker so the
 * package stays queue-agnostic and unit-testable.
 */

/** A transient provider failure: the worker must retry (and eventually dead-letter). */
export class RetryableDeliveryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RetryableDeliveryError';
    this.code = code;
  }
}

export interface DeliveryServiceDeps extends SweepDeps {
  provider: EmailProvider | null;
}

/**
 * The subset of {@link SweepDeps} a single delivery attempt needs — so the
 * worker can hand a delivery job a plain object without sweep plumbing.
 */
export type DeliveryAttemptDeps = Pick<SweepDeps, 'db' | 'clock' | 'logger' | 'appUrl'> & {
  provider: EmailProvider | null;
};

export interface DeliveryAttemptResult {
  outcome: 'sent' | 'idempotent-sent' | 'not-found' | 'failed-permanent';
}

/**
 * Attempts one email delivery for a queued notification.
 *
 * Called by the delivery worker. The idempotency guard (has the provider already
 * accepted this notification?) protects against send-then-crash double-sends.
 * Transient failures throw {@link RetryableDeliveryError} so the worker's
 * retry machinery applies; permanent failures dead-letter immediately and
 * return normally.
 */
export const deliverQueuedEmail = async (
  deps: DeliveryAttemptDeps,
  { notificationId, emailLogId }: { notificationId: string; emailLogId: string },
): Promise<DeliveryAttemptResult> => {
  const { db, clock, logger, appUrl, provider } = deps;
  const now = clock.now();

  const notification = await db.notification.findUnique({ where: { id: notificationId } });
  if (notification === null) {
    return { outcome: 'not-found' };
  }
  const emailLog = await db.emailLog.findUnique({ where: { id: emailLogId } });
  if (emailLog === null) {
    return { outcome: 'not-found' };
  }

  const alreadySent = await delivery.findOutcomeEmailForNotification(db, notificationId);
  if (alreadySent !== null) {
    await delivery.markNotificationSent(db, notificationId, now);
    return { outcome: 'idempotent-sent' };
  }

  if (provider === null) {
    throw new RetryableDeliveryError('provider-unconfigured', 'No email provider configured.');
  }

  const template = TEMPLATE_NAMES.find((candidate) => candidate === emailLog.template);
  if (template === undefined) {
    await failPermanently(
      deps,
      notificationId,
      { code: 'template-unknown', message: `Unknown template: ${emailLog.template}` },
      emailLogId,
    );
    return { outcome: 'failed-permanent' };
  }

  let rendered: { subject: string; html: string };
  try {
    rendered = renderEmail(template, (emailLog.data ?? {}) as Record<string, unknown>, appUrl);
  } catch (error) {
    await failPermanently(
      deps,
      notificationId,
      {
        code: 'template-data-invalid',
        message: error instanceof Error ? error.message : 'Template render failed.',
      },
      emailLogId,
    );
    return { outcome: 'failed-permanent' };
  }

  logger.info({ notificationId, emailLogId, template }, 'notification: sending email');

  const send = await provider.send({
    to: emailLog.recipient,
    subject: rendered.subject,
    html: rendered.html,
    providerReference: notificationId,
  });

  if (send.ok) {
    await delivery.updateEmailAttempt(db, emailLogId, {
      status: 'SENT',
      sentAt: now,
      providerMessageId: send.providerMessageId,
    });
    await delivery.markNotificationSent(db, notificationId, now);
    await audit.appendEvent(db, notification.userId, {
      eventType: 'NOTIFICATION_SENT',
      aggregateType: 'NOTIFICATION',
      aggregateId: notificationId,
      payload: { provider: 'agentmail', providerMessageId: send.providerMessageId },
      occurredAt: now,
      causationId: notificationId,
    });
    await audit.recordAgentAction(db, notification.userId, {
      actionType: 'NOTIFICATION_DISPATCHED',
      outcome: 'SUCCEEDED',
      entityType: 'NOTIFICATION',
      entityId: notificationId,
      reason: 'provider-accepted',
      factors: { provider: 'agentmail', providerMessageId: send.providerMessageId },
      correlationId: notificationId,
    });
    return { outcome: 'sent' };
  }

  const reason = `${send.failure.code}: ${send.failure.message}`;
  await delivery.updateEmailAttempt(db, emailLogId, { status: 'FAILED', failureReason: reason });
  await audit.recordAgentAction(db, notification.userId, {
    actionType: 'NOTIFICATION_DISPATCHED',
    outcome: 'FAILED',
    entityType: 'NOTIFICATION',
    entityId: notificationId,
    reason: reason.slice(0, 500),
    factors: { provider: 'agentmail', code: send.failure.code },
    correlationId: notificationId,
  });

  if (send.failure.kind === 'permanent') {
    await delivery.markNotificationFailed(db, notificationId, reason, now);
    await audit.appendEvent(db, notification.userId, {
      eventType: 'NOTIFICATION_FAILED',
      aggregateType: 'NOTIFICATION',
      aggregateId: notificationId,
      payload: { reason, permanent: true },
      occurredAt: now,
      causationId: notificationId,
    });
    return { outcome: 'failed-permanent' };
  }

  throw new RetryableDeliveryError(send.failure.code, reason);
};

const failPermanently = async (
  deps: DeliveryAttemptDeps,
  notificationId: string,
  failure: { code: string; message: string },
  emailLogId: string,
): Promise<void> => {
  const { db, clock } = deps;
  const now = clock.now();
  const reason = `${failure.code}: ${failure.message}`;

  await delivery.updateEmailAttempt(db, emailLogId, { status: 'FAILED', failureReason: reason });
  await delivery.markNotificationFailed(db, notificationId, reason, now);
  const notification = await db.notification.findUnique({ where: { id: notificationId } });
  if (notification === null) {
    return;
  }
  await audit.appendEvent(db, notification.userId, {
    eventType: 'NOTIFICATION_FAILED',
    aggregateType: 'NOTIFICATION',
    aggregateId: notificationId,
    payload: { reason, permanent: true },
    occurredAt: now,
    causationId: notificationId,
  });
};

/**
 * Final dead-letter for a notification whose delivery retries were exhausted.
 * Called by the worker when a delivery's final attempt fails.
 */
export const finalizeFailedDelivery = async (
  deps: DeliveryAttemptDeps,
  { notificationId, reason }: { notificationId: string; reason: string },
): Promise<void> => {
  const { db, clock } = deps;
  const now = clock.now();
  const before = reason.slice(0, 500);

  await delivery.markNotificationFailed(db, notificationId, before, now);

  const notification = await db.notification.findUnique({ where: { id: notificationId } });
  if (notification === null) {
    return;
  }
  const userId = notification.userId;

  await audit.appendEvent(db, userId, {
    eventType: 'NOTIFICATION_FAILED',
    aggregateType: 'NOTIFICATION',
    aggregateId: notificationId,
    payload: { reason: before, permanent: true, finalized: true },
    occurredAt: now,
    causationId: notificationId,
  });
  await audit.recordAgentAction(db, userId, {
    actionType: 'NOTIFICATION_DISPATCHED',
    outcome: 'FAILED',
    entityType: 'NOTIFICATION',
    entityId: notificationId,
    reason: `retries-exhausted: ${before}`,
    factors: { provider: 'agentmail' },
    correlationId: notificationId,
  });
};

export interface NotificationService {
  runSweep(): Promise<SweepResult>;
  deliverQueuedEmail(input: {
    notificationId: string;
    emailLogId: string;
  }): Promise<DeliveryAttemptResult>;
  finalizeFailedDelivery(input: { notificationId: string; reason: string }): Promise<void>;
}

export const createNotificationService = (deps: DeliveryServiceDeps): NotificationService => ({
  runSweep: (opts?: { batchSize?: number; limit?: number }) => runSweep(deps, opts),
  deliverQueuedEmail: (input) => deliverQueuedEmail(deps, input),
  finalizeFailedDelivery: (input) => finalizeFailedDelivery(deps, input),
});
