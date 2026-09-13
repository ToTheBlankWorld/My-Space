import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/http';
import { requireApiUser, requireSameOrigin, spendRateLimit, withApi } from '@/server/api';
import { enqueueCalendarSync } from '@/server/calendar-queue';
import { getCalendarDatabase, getCalendarLogger } from '@/server/calendar';

/**
 * POST /api/calendar/sync
 *
 * Enqueues a calendar sync job for the authenticated user.
 *
 * This endpoint does NOT perform the sync synchronously. It verifies
 * ownership, inserts a durable `BackgroundJob` row, and returns accepted; the
 * worker performs the actual Google API call. Enqueueing needs only the
 * database — no Redis — so this endpoint never degrades to "not configured".
 * A database failure at insert time is the only 503, and it means exactly
 * that: not queued.
 *
 * Request body:
 *   { connectionId: string, calendarId?: string, fullSync?: boolean }
 */
export const POST = withApi(async (request: Request) => {
  const user = await requireApiUser();
  requireSameOrigin(request);
  spendRateLimit('calendarSync', user.user.id);
  const logger = getCalendarLogger();

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const body = parsed.body as {
    connectionId?: string;
    calendarId?: string;
    fullSync?: boolean;
  };

  if (!body.connectionId) {
    return NextResponse.json({ error: 'connectionId is required.' }, { status: 400 });
  }

  // Ownership is the trust boundary: `connectionId` from the client is input,
  // never authority. A row belonging to another user is "not found" — and it
  // is checked BEFORE anything is enqueued.
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

  const accepted = await enqueueCalendarSync(db, {
    userId: user.user.id,
    connectionId: connection.id,
    calendarId: body.calendarId,
    fullSync: body.fullSync ?? false,
  }).catch((error: unknown) => {
    logger.error({ err: error }, 'manual sync enqueue failed');
    return false;
  });

  if (!accepted) {
    return NextResponse.json(
      { error: 'The sync queue is not available right now; try again.' },
      { status: 503 },
    );
  }

  return NextResponse.json({ status: 'accepted' }, { status: 202 });
});
