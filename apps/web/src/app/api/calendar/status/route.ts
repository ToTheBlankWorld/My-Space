import { NextResponse } from 'next/server';

import { requireApiUser, withApi } from '@/server/api';
import { getCalendarDatabase } from '@/server/calendar';

/**
 * GET /api/calendar/status
 *
 * Returns the sync status for all calendar connections belonging to the
 * authenticated user. Does not expose tokens or provider credentials.
 */
export const GET = withApi(async (): Promise<NextResponse> => {
  const user = await requireApiUser();
  const db = getCalendarDatabase();

  const connections = await db.calendarConnection.findMany({
    where: { userId: user.user.id },
    select: {
      id: true,
      provider: true,
      providerAccountId: true,
      status: true,
      lastSyncedAt: true,
      lastErrorAt: true,
      lastErrorMessage: true,
      grantedScopes: true,
      _count: { select: { calendars: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  return NextResponse.json({ connections });
});
