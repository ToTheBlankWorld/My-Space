import 'server-only';

import { delivery, type Notification } from '@space/database';
import type { Page, PageRequest } from '@space/types';

import { clock } from './clock';
import { getDatabase } from './database';

/**
 * The web application's notification read surface.
 *
 * Everything here is ownership-scoped read/acknowledge over the rows the Stage 7
 * engine wrote. There is deliberately nothing else: outbox consumption, reminder
 * dispatch and email delivery all run in the worker, and the provider log never
 * crosses this boundary.
 */
export interface NotificationsService {
  unreadCount(userId: string): Promise<number>;
  list(
    userId: string,
    options?: { unreadOnly?: boolean; page?: PageRequest },
  ): Promise<Page<Notification>>;
  markRead(userId: string, notificationId: string): Promise<boolean>;
  markAllRead(userId: string): Promise<number>;
}

export const getNotificationsService = (): NotificationsService => {
  const db = getDatabase();

  return {
    unreadCount: (userId) => delivery.countUnreadNotifications(db, userId),
    list: (userId, options) => delivery.listNotifications(db, userId, options),
    markRead: (userId, notificationId) =>
      delivery.markNotificationRead(db, userId, notificationId, clock.now()),
    markAllRead: (userId) => delivery.markAllNotificationsRead(db, userId, clock.now()),
  };
};
