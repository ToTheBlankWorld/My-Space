import {
  decryptCalendarTokens,
  GoogleCalendarProvider,
  recordCalendarConnectionEvent,
} from '@space/calendar';
import { NextResponse } from 'next/server';

import { getCalendarDatabase, getCalendarKeyring, getCalendarLogger } from '@/server/calendar';
import { requireUser } from '@/server/session';

/**
 * POST /api/calendar/disconnect
 *
 * Disconnects a calendar connection. Best-effort revokes the OAuth access at
 * Google, marks the connection DISCONNECTED and deselects its calendars. The
 * mirrored events are kept: they belong to the user and their plans reference
 * them.
 *
 * Request body:
 *   { connectionId: string }
 */
export const POST = async (request: Request) => {
  const user = await requireUser();
  const db = getCalendarDatabase();
  const keyring = getCalendarKeyring();
  const logger = getCalendarLogger();

  let body: { connectionId?: string };
  try {
    body = (await request.json()) as { connectionId?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body.connectionId) {
    return NextResponse.json({ error: 'connectionId is required.' }, { status: 400 });
  }

  const connection = await db.calendarConnection.findFirst({
    where: {
      id: body.connectionId,
      userId: user.user.id,
    },
  });

  if (!connection) {
    return NextResponse.json({ error: 'Connection not found.' }, { status: 404 });
  }

  // Revoke at the provider, best-effort: a failed revocation is logged and the
  // local state is still disconnected. A revoked token that lingers server-side
  // is harmless; a stuck "connected" state is not.
  try {
    const decrypted = decryptCalendarTokens(keyring, connection);
    await new GoogleCalendarProvider().revokeAccess(decrypted.accessToken);
  } catch (error) {
    logger.warn({ err: error, connectionId: connection.id }, 'token revocation failed');
  }

  await db.$transaction([
    db.calendarConnection.update({
      where: { id: connection.id },
      data: { status: 'DISCONNECTED', syncCursor: null, lastErrorAt: null, lastErrorMessage: null },
    }),
    db.calendar.updateMany({
      where: { connectionId: connection.id, userId: user.user.id },
      data: { isSelected: false },
    }),
  ]);

  await recordCalendarConnectionEvent(db, user.user.id, {
    eventType: 'CALENDAR_DISCONNECTED',
    connectionId: connection.id,
    payload: { provider: connection.provider },
  });

  return NextResponse.json({ status: 'disconnected' });
};
