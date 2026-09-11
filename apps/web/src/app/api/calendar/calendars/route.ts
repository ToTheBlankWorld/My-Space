import { NextResponse } from 'next/server';

import { requireApiUser, withApi } from '@/server/api';
import { getCalendarDatabase } from '@/server/calendar';

/**
 * GET /api/calendar/calendars
 *
 * Returns the list of calendars for the authenticated user's connections.
 * Does not make a live Google API call — returns the locally stored calendar
 * records that were discovered during connection or the last sync.
 */
export const GET = withApi(async () => {
  const user = await requireApiUser();
  const db = getCalendarDatabase();

  const calendars = await db.calendar.findMany({
    where: { userId: user.user.id },
    select: {
      id: true,
      connectionId: true,
      connection: { select: { provider: true } },
      externalId: true,
      name: true,
      description: true,
      timeZone: true,
      isPrimary: true,
      isSelected: true,
      color: true,
      _count: { select: { events: true } },
    },
    orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
  });

  return NextResponse.json({ calendars });
});
