import { NextResponse } from 'next/server';

import { getCalendarDatabase } from '@/server/calendar';
import { requireUser } from '@/server/session';

/**
 * GET /api/calendar/status
 *
 * Returns the sync status for all calendar connections belonging to the
 * authenticated user. Does not expose tokens or provider credentials.
 */
export const GET = async (): Promise<NextResponse> => {
  const user = await requireUser();
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
};
