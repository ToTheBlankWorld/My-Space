import type { EmailStatus, PageRequest } from '@space/types';
import { createNotificationSchema, parseOrThrow } from '@space/validation';
import { type z } from 'zod';

import type { Database } from '../client';
import { withDomainErrors } from '../errors';
import { cursorQuery, toPage } from '../pagination';

/**
 * Notifications and the outbound email log.
 *
 * Nothing here sends anything. Stage 4 adds the dispatcher and the AgentMail
 * client; this is the record they will read and write.
 */

export type CreateNotificationInput = z.input<typeof createNotificationSchema>;

export const createNotification = async (
  db: Database,
  userId: string,
  input: CreateNotificationInput,
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

export interface RecordEmailInput {
  userId?: string | null;
  recipient: string;
  template: string;
  provider: string;
  providerMessageId?: string | null;
  status?: EmailStatus;
}

/**
 * Records an outbound email.
 *
 * The rendered body is deliberately not stored: it contains the user's own
 * content, and a log table is the wrong place to keep a second copy of it. The
 * template name is enough to reconstruct what was sent.
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
