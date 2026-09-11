import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/http';
import { requireApiUser, requireSameOrigin, spendRateLimit, withApi } from '@/server/api';
import { getNotificationsService } from '@/server/notifications';

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
export const POST = withApi(async (request: Request) => {
  const context = await requireApiUser();
  requireSameOrigin(request);
  spendRateLimit('notificationRead', context.user.id);

  const result = await readJsonBody(request);
  if (!result.ok) {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const body = result.body as { id?: unknown; all?: unknown };
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
});
