import { NextResponse } from 'next/server';

import { getNotificationsService } from '@/server/notifications';
import { getOptionalUser } from '@/server/session';

/**
 * POST /api/notifications/read
 *
 * Marks one notification (`{ id }`) or every notification (`{ all: true }`) as
 * read for the authenticated user. Ownership is always scoped by the session's
 * user id, never by a field in the body.
 *
 * A single mark returns `{ updated: true | false }` (false when the row was
 * already read or does not belong to the user); `all` returns the number of
 * rows changed.
 */
export const POST = async (request: Request): Promise<NextResponse> => {
  const context = await getOptionalUser();
  if (!context) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  let body: { id?: unknown; all?: unknown };
  try {
    body = (await request.json()) as { id?: unknown; all?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const service = getNotificationsService();

  if (body.all === true) {
    const updated = await service.markAllRead(context.user.id);
    return NextResponse.json({ updated });
  }

  if (typeof body.id === 'string' && body.id.length > 0) {
    const updated = await service.markRead(context.user.id, body.id);
    return NextResponse.json({ updated });
  }

  return NextResponse.json(
    { error: 'Provide `{ "id": string }` or `{ "all": true }`.' },
    { status: 400 },
  );
};
