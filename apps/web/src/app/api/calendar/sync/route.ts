import { NextResponse } from 'next/server';

import { enqueueCalendarSync, calendarQueueAvailable } from '@/server/calendar-queue';
import { getCalendarDatabase } from '@/server/calendar';
import { requireUser } from '@/server/session';

/**
 * POST /api/calendar/sync
 *
 * Enqueues a calendar sync job for the authenticated user.
 *
 * This endpoint does NOT perform the sync synchronously. It verifies ownership,
 * enqueues a BullMQ job in the worker's queue, and returns accepted. The worker
 * performs the actual Google API call.
 *
 * Request body:
 *   { connectionId: string, calendarId?: string, fullSync?: boolean }
 */
export const POST = async (request: Request) => {
  const user = await requireUser();

  let body: { connectionId?: string; calendarId?: string; fullSync?: boolean };
  try {
    body = (await request.json()) as {
      connectionId?: string;
      calendarId?: string;
      fullSync?: boolean;
    };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body.connectionId) {
    return NextResponse.json({ error: 'connectionId is required.' }, { status: 400 });
  }

  // Ownership is the trust boundary: `connectionId` from the client is input,
  // never authority. A row belonging to another user is "not found".
  const db = getCalendarDatabase();
  const connection = await db.calendarConnection.findFirst({
    where: {
      id: body.connectionId,
      userId: user.user.id,
    },
    select: { id: true, status: true },
  });

  if (!connection) {
    return NextResponse.json({ error: 'Connection not found.' }, { status: 404 });
  }

  if (connection.status !== 'CONNECTED') {
    return NextResponse.json(
      { error: 'Connection is not connected; reconnect it before syncing.' },
      { status: 409 },
    );
  }

  if (!calendarQueueAvailable()) {
    return NextResponse.json(
      { error: 'Background sync is not configured on this deployment.' },
      { status: 503 },
    );
  }

  const accepted = await enqueueCalendarSync({
    userId: user.user.id,
    connectionId: connection.id,
    calendarId: body.calendarId,
    fullSync: body.fullSync ?? false,
  });

  if (!accepted) {
    return NextResponse.json(
      { error: 'Background sync is not available right now.' },
      { status: 503 },
    );
  }

  return NextResponse.json({ status: 'accepted' }, { status: 202 });
};
