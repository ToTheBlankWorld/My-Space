import type { EmailStatus, PageRequest } from '@space/types';
import { createNotificationSchema, parseOrThrow } from '@space/validation';
import { type z } from 'zod';

import type { Database } from '../client';
import { type Prisma } from '../generated/prisma/client';
import { withDomainErrors } from '../errors';
import { cursorQuery, toPage } from '../pagination';

/**
 * Notifications and the outbound email log.
 *
 * Nothing here sends anything. Stage 7 adds the notification pipeline: the
 * policy/outbox processor and the delivery worker are the code that reads and
 * writes these records.
 */

export type CreateNotificationInput = z.input<typeof createNotificationSchema>;

export interface CreateNotificationOptions {
  /** Stable, server-generated idempotency key. Unique in the database. */
  deliveryKey?: string | null;
  /** Safe in-app deep link (APP_URL based), built by policy — never user input. */
  linkUrl?: string | null;
}

export const createNotification = async (
  db: Database,
  userId: string,
  input: CreateNotificationInput,
  options: CreateNotificationOptions = {},
) => {
  const data = parseOrThrow(createNotificationSchema, input, 'notification');

  return withDomainErrors('Notification', () =>
    db.notification.create({
      data: {
        userId,
        type: data.type,
        priority: data.priority,
        title: data.title,
        body: data.body,
        scheduledAt: data.scheduledAt ?? null,
        deliveryKey: options.deliveryKey ?? null,
        linkUrl: options.linkUrl ?? null,
      },
    }),
  );
};

/** A user's notifications, newest first. */
export const listNotifications = async (
  db: Database,
  userId: string,
  { unreadOnly = false, page = {} }: { unreadOnly?: boolean; page?: PageRequest } = {},
) => {
  const rows = await db.notification.findMany({
    where: { userId, ...(unreadOnly ? { readAt: null } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...cursorQuery(page),
  });

  return toPage(rows, page);
};

/**
 * The unread badge.
 *
 * A `count` against the `(userId, readAt)` index, never a fetch-and-length: the
 * badge must not get slower as a user's history grows.
 */
export const countUnreadNotifications = async (db: Database, userId: string) =>
  db.notification.count({ where: { userId, readAt: null } });

export const markNotificationRead = async (
  db: Database,
  userId: string,
  notificationId: string,
  readAt: Date,
) => {
  const result = await db.notification.updateMany({
    // Already-read rows are excluded so the original read time is preserved.
    where: { id: notificationId, userId, readAt: null },
    data: { readAt },
  });

  return result.count === 1;
};

export const markAllNotificationsRead = async (db: Database, userId: string, readAt: Date) => {
  const result = await db.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt },
  });

  return result.count;
};

/** Notifications whose scheduled time has arrived. Cross-user, bounded batch. */
export const listDueNotifications = async (
  db: Database,
  { now, limit = 100 }: { now: Date; limit?: number },
) =>
  db.notification.findMany({
    where: {
      deliveryState: 'PENDING',
      priority: { not: 'SILENT' },
      OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
    },
    orderBy: [{ priority: 'asc' }, { scheduledAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
    take: Math.min(Math.max(limit, 1), 500),
  });

/**
 * Notifications the sweep may hand to the delivery queue.
 *
 * Two classes:
 *  - **Pending and due** — the normal case, claimed by flipping to `QUEUED`;
 *  - **Queued but stale** — the crash-recovery case: a `QUEUED` row whose job
 *    was never (re)added after a worker died between the claim and `queue.add`.
 *    These are re-enqueued with the same deterministic `jobId`, which BullMQ
 *    dedupes if a job already exists, and the delivery worker's idempotency
 *    check makes a completed job a no-op.
 */
export const listDispatchableNotifications = async (
  db: Database,
  {
    now,
    limit = 100,
    staleQueuedAfterMinutes = 10,
  }: { now: Date; limit?: number; staleQueuedAfterMinutes?: number },
) => {
  const staleBefore = new Date(now.getTime() - staleQueuedAfterMinutes * 60_000);

  return db.notification.findMany({
    where: {
      priority: { not: 'SILENT' },
      OR: [
        {
          deliveryState: 'PENDING',
          OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
        },
        { deliveryState: 'QUEUED', updatedAt: { lte: staleBefore } },
      ],
    },
    orderBy: [
      { deliveryState: 'asc' },
      { scheduledAt: { sort: 'asc', nulls: 'first' } },
      { id: 'asc' },
    ],
    take: Math.min(Math.max(limit, 1), 500),
  });
};

/**
 * Atomically claims a pending, due notification for the delivery queue.
 *
 * `updateMany` with the current state is a compare-and-swap: exactly one worker
 * wins a concurrent claim. Returns true only for the winner, so the caller can
 * skip enqueueing a duplicate job for everyone else.
 */
export const claimNotificationForDispatch = async (
  db: Database,
  notificationId: string,
  queuedAt: Date,
) => {
  const result = await db.notification.updateMany({
    where: { id: notificationId, deliveryState: 'PENDING' },
    data: { deliveryState: 'QUEUED', updatedAt: queuedAt },
  });

  return result.count === 1;
};

export const markNotificationSent = async (db: Database, notificationId: string, sentAt: Date) => {
  const result = await db.notification.updateMany({
    where: { id: notificationId, deliveryState: 'QUEUED' },
    data: { deliveryState: 'SENT', sentAt },
  });

  return result.count === 1;
};

/** Marks a delivery permanently failed (dead-letter). Not retryable by state. */
export const markNotificationFailed = async (
  db: Database,
  notificationId: string,
  failureReason: string,
  at: Date,
) => {
  const result = await db.notification.updateMany({
    where: { id: notificationId, deliveryState: { in: ['QUEUED', 'PENDING'] } },
    data: { deliveryState: 'FAILED', failureReason: failureReason.slice(0, 500), updatedAt: at },
  });

  return result.count === 1;
};

/** Marks a notification skipped without ever queueing it (e.g. prefs off). */
export const markNotificationSkipped = async (
  db: Database,
  notificationId: string,
  failureReason: string,
  at: Date,
) => {
  const result = await db.notification.updateMany({
    where: { id: notificationId, deliveryState: 'PENDING' },
    data: { deliveryState: 'SKIPPED', failureReason: failureReason.slice(0, 500), updatedAt: at },
  });

  return result.count === 1;
};

export interface RecordEmailInput {
  userId?: string | null;
  recipient: string;
  template: string;
  provider: string;
  providerMessageId?: string | null;
  status?: EmailStatus;
  /** Bounded structured template data; never the rendered body. */
  data?: Record<string, unknown> | null;
  notificationId?: string | null;
}

/**
 * Records an outbound email.
 *
 * The rendered body is deliberately not stored: it contains the user's own
 * content, and a log table is the wrong place to keep a second copy of it. The
 * template name and its structured data are enough to reconstruct what was sent.
 */
export const recordEmail = async (db: Database, input: RecordEmailInput) =>
  withDomainErrors('EmailLog', () =>
    db.emailLog.create({
      data: {
        userId: input.userId ?? null,
        recipient: input.recipient.trim().toLowerCase(),
        template: input.template,
        provider: input.provider,
        providerMessageId: input.providerMessageId ?? null,
        status: input.status ?? 'QUEUED',
        data: (input.data ?? undefined) as Prisma.InputJsonObject | undefined,
        notificationId: input.notificationId ?? null,
      },
    }),
  );

/** Applies a provider status callback to an existing log row. */
export const updateEmailStatus = async (
  db: Database,
  { provider, providerMessageId }: { provider: string; providerMessageId: string },
  { status, failureReason, sentAt }: { status: EmailStatus; failureReason?: string; sentAt?: Date },
) => {
  const result = await db.emailLog.updateMany({
    where: { provider, providerMessageId },
    data: {
      status,
      failureReason: failureReason ?? null,
      sentAt: sentAt ?? null,
      ...(status === 'FAILED' ? { retryCount: { increment: 1 } } : {}),
    },
  });

  return result.count === 1;
};

/**
 * Delivery-worker idempotency check: has this notification already been
 * accepted by the provider? A crash between a successful provider call and its
 * persistence must not resend the message, so the worker checks this before
 * invoking the provider again.
 */
export const findOutcomeEmailForNotification = async (db: Database, notificationId: string) =>
  db.emailLog.findFirst({
    where: { notificationId, status: { in: ['SENT', 'DELIVERED', 'BOUNCED'] } },
    orderBy: { createdAt: 'desc' },
  });

/**
 * Updates the log row for one notification delivery attempt by its own row id
 * (not by provider id, which is unknown until the call returns).
 */
export const updateEmailAttempt = async (
  db: Database,
  emailLogId: string,
  {
    status,
    failureReason,
    sentAt,
    providerMessageId,
  }: {
    status: EmailStatus;
    failureReason?: string;
    sentAt?: Date;
    providerMessageId?: string | null;
  },
) => {
  const result = await db.emailLog.updateMany({
    where: { id: emailLogId },
    data: {
      status,
      failureReason: failureReason ?? null,
      sentAt: sentAt ?? null,
      providerMessageId: providerMessageId ?? null,
      ...(status === 'FAILED' ? { retryCount: { increment: 1 } } : {}),
    },
  });

  return result.count === 1;
};
