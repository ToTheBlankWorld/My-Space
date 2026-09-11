import {
  decryptCalendarTokens,
  GoogleCalendarProvider,
  recordCalendarConnectionEvent,
} from '@space/calendar';
import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/http';
import { requireApiUser, requireSameOrigin, spendRateLimit, withApi } from '@/server/api';
import { getCalendarDatabase, getCalendarKeyring, getCalendarLogger } from '@/server/calendar';

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
export const POST = withApi(async (request: Request) => {
  const user = await requireApiUser();
  requireSameOrigin(request);
  spendRateLimit('calendarDisconnect', user.user.id);
  const db = getCalendarDatabase();
  const keyring = getCalendarKeyring();
  const logger = getCalendarLogger();

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const body = parsed.body as { connectionId?: string };

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
});
