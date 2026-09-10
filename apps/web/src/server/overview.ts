import 'server-only';

import { spaces, work } from '@space/database';
import type { CalendarDate, TimeZone } from '@space/types';
import { addCalendarDays } from '@space/time';

import { clock } from './clock';
import { getDatabase } from './database';
import { getNotificationsService } from './notifications';
import { getPlanningService } from './planning';

/**
 * The dashboard's read surface.
 *
 * One bounded set of ownership-scoped queries assembled into plain views the
 * page renders directly. Nothing here creates a Space or writes a row: the
 * overview only ever reflects what already exists.
 */

export interface OverviewDay {
  date: CalendarDate;
  weekday: string;
  planned: boolean;
}

export interface OverviewData {
  today: CalendarDate;
  timeZone: TimeZone;
  due: number;
  overdue: number;
  unread: number;
  todayPlanned: boolean;
  days: OverviewDay[];
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const getOverview = async (userId: string): Promise<OverviewData> => {
  const { date, timeZone } = await getPlanningService().getToday(userId);
  const db = getDatabase();
  const now = clock.now();

  const [counts, todaySpace, weekSpaces, unread] = await Promise.all([
    work.countTasksForOverview(db, userId, { now }),
    spaces.findSpaceByDate(db, userId, date),
    spaces.listSpacesInRange(db, userId, date, addCalendarDays(date, 6)),
    getNotificationsService().unreadCount(userId),
  ]);

  const plannedDates = new Set(
    weekSpaces.filter((space) => space.planVersion > 0).map((space) => space.date),
  );

  const days: OverviewDay[] = Array.from({ length: 7 }, (_, index) => {
    const day = addCalendarDays(date, index);
    const instant = new Date(`${day}T12:00:00Z`);
    return {
      date: day,
      weekday: WEEKDAYS[(instant.getUTCDay() + 6) % 7] ?? '',
      planned: plannedDates.has(day),
    };
  });

  return {
    today: date,
    timeZone,
    due: counts.due,
    overdue: counts.overdue,
    unread,
    todayPlanned: todaySpace?.planVersion !== undefined && todaySpace.planVersion > 0,
    days,
  };
};
