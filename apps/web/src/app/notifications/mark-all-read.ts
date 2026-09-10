'use server';

import { revalidatePath } from 'next/cache';

import { getNotificationsService } from '@/server/notifications';
import { requireUser } from '@/server/session';

/**
 * Marks every notification of the signed-in user as read.
 *
 * A plain form action so the page never needs client JavaScript: the button
 * submits, the action revalidates the list, and Next re-renders it.
 */
export const markAllNotificationsRead = async (): Promise<void> => {
  const context = await requireUser();
  await getNotificationsService().markAllRead(context.user.id);
  revalidatePath('/notifications');
};
