import 'server-only';

import { calendar } from '@space/database';
import type { CalendarDate, ConnectionStatus, TimeZone } from '@space/types';
import { addCalendarDays, startOfCalendarDate, toCalendarDate } from '@space/time';

import { getCalendarDatabase, getGoogleOAuthConfig } from './calendar';
import { getPlanningService } from './planning';

/**
 * The calendar page's read surface.
 *
 * Connections are selected without anything token-shaped and mirrored events
 * come from the local copy of the provider — never a network call. The window
 * is fixed to seven days in the user's timezone, which bounds the query by
 * construction.
 */

export interface CalendarConnectionView {
  id: string;
  provider: string;
  providerAccountId: string;
  status: ConnectionStatus;
  lastSyncedAt: string | null;
  calendarCount: number;
}

export interface CalendarEventView {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  location: string | null;
}

export interface CalendarSummaryData {
  timeZone: TimeZone;
  connections: CalendarConnectionView[];
  days: { date: CalendarDate; events: CalendarEventView[] }[];
  hasOAuthConfig: boolean;
}

export const getCalendarSummary = async (userId: string): Promise<CalendarSummaryData> => {
  const { date, timeZone } = await getPlanningService().getToday(userId);
  const db = getCalendarDatabase();

  const [connections, events] = await Promise.all([
    db.calendarConnection.findMany({
      where: { userId },
      select: {
        id: true,
        provider: true,
        providerAccountId: true,
        status: true,
        lastSyncedAt: true,
        _count: { select: { calendars: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    calendar.listCalendarEventsInRange(db, userId, {
      start: startOfCalendarDate(date, timeZone),
      end: startOfCalendarDate(addCalendarDays(date, 7), timeZone),
    }),
  ]);

  let hasOAuthConfig = false;
  try {
    const cfg = getGoogleOAuthConfig();
    hasOAuthConfig = Boolean(cfg.clientId && cfg.clientSecret);
  } catch {
    // Leave the capability flag off: a missing or partial google config means
    // there is nothing safe to connect to.
  }

  const byDay = new Map<CalendarDate, CalendarEventView[]>();
  for (const event of events) {
    const day = toCalendarDate(event.startAt, timeZone);
    byDay.set(day, [
      ...(byDay.get(day) ?? []),
      {
        id: event.id,
        title: event.title,
        startAt: event.startAt.toISOString(),
        endAt: event.endAt.toISOString(),
        allDay: event.isAllDay,
        location: event.location,
      },
    ]);
  }

  const days = Array.from({ length: 7 }, (_, index) => {
    const day = addCalendarDays(date, index);
    return { date: day, events: byDay.get(day) ?? [] };
  });

  return {
    timeZone,
    connections: connections.map((connection) => ({
      id: connection.id,
      provider: connection.provider,
      providerAccountId: connection.providerAccountId,
      status: connection.status,
      lastSyncedAt: connection.lastSyncedAt?.toISOString() ?? null,
      calendarCount: connection._count.calendars,
    })),
    days,
    hasOAuthConfig,
  };
};
