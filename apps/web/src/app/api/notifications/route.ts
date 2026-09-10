import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { getNotificationsService } from '@/server/notifications';
import { getOptionalUser } from '@/server/session';

/**
 * GET /api/notifications
 *
 * Lists the authenticated user's notifications, newest first, with the unread
 * badge count. `?unread=1` returns unread rows only.
 *
 * The payload is shaped here to the consumer's needs and is the one sanctioned
 * read surface for in-app notifications: the email log and provider internals
 * are never exposed.
 */
export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const context = await getOptionalUser();
  if (!context) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const unreadOnly = new URL(request.url).searchParams.get('unread') === '1';

  const service = getNotificationsService();
  const [unread, page] = await Promise.all([
    service.unreadCount(context.user.id),
    service.list(context.user.id, { unreadOnly }),
  ]);

  return NextResponse.json({
    unread,
    notifications: page.items.map((row) => ({
      id: row.id,
      type: row.type,
      priority: row.priority,
      title: row.title,
      body: row.body,
      linkUrl: row.linkUrl,
      readAt: row.readAt,
      scheduledAt: row.scheduledAt,
      createdAt: row.createdAt,
      deliveryState: row.deliveryState,
    })),
  });
};
