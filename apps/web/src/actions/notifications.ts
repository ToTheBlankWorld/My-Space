'use server';

import { revalidatePath } from 'next/cache';

import { getNotificationsService } from '@/server/notifications';
import { requireUser } from '@/server/session';

/**
 * Notification mutations.
 *
 * Both actions are scoped to the session actor and revalidate the inbox so the
 * unread badge (header and page) re-reads the database after every change.
 */

export const markNotificationRead = async (formData: FormData): Promise<void> => {
  const id = formData.get('id');
  if (typeof id !== 'string' || id.length === 0) {
    return;
  }

  const { user } = await requireUser();
  await getNotificationsService().markRead(user.id, id);
  revalidatePath('/notifications');
};

export const markAllNotificationsRead = async (): Promise<void> => {
  const { user } = await requireUser();
  await getNotificationsService().markAllRead(user.id);
  revalidatePath('/notifications');
};
