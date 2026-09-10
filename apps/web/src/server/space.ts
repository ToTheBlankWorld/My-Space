import 'server-only';

import { audit, users } from '@space/database';
import type { AutonomyLevel, CalendarDate, TimeZone } from '@space/types';
import { minuteOfDayAt, toCalendarDate } from '@space/time';

import { clock } from './clock';
import { getDatabase } from './database';
import { getPlanningService } from './planning';

/**
 * Server-side read surface for the day workspace.
 *
 * Bundles the authoritative day, a bounded slice of the space's autonomy trail
 * and the user's planning profile into plain, serialisable views the page and
 * its client components can render. Nothing here is a write path.
 */

export interface AgentActionView {
  id: string;
  actionType: string;
  outcome: string;
  entityId: string | null;
  reason: string;
  previousStart: string | null;
  previousEnd: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  occurredAt: string;
}

export interface SpaceDayData {
  day: Awaited<ReturnType<typeof loadDay>>;
  autonomy: AutonomyLevel;
  agentActions: AgentActionView[];
  isToday: boolean;
  nowMinute: number | null;
}

type DayState = SpaceDayData['day'];

const loadDay = async (userId: string, date: CalendarDate) =>
  getPlanningService().getDayState({ userId, date });

const readState = (value: unknown, key: string): string | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === 'string' ? entry : null;
};

const toAgentActionView = (row: {
  id: string;
  actionType: string;
  outcome: string;
  entityId: string | null;
  reason: string;
  previousState: unknown;
  resultingState: unknown;
  occurredAt: Date;
}): AgentActionView => ({
  id: row.id,
  actionType: row.actionType,
  outcome: row.outcome,
  entityId: row.entityId,
  reason: row.reason,
  previousStart: readState(row.previousState, 'scheduledStart'),
  previousEnd: readState(row.previousState, 'scheduledEnd'),
  scheduledStart: readState(row.resultingState, 'scheduledStart'),
  scheduledEnd: readState(row.resultingState, 'scheduledEnd'),
  occurredAt: row.occurredAt.toISOString(),
});

export const getSpaceDayData = async (
  userId: string,
  date: CalendarDate,
): Promise<SpaceDayData> => {
  const day = await loadDay(userId, date);

  const db = getDatabase();
  const [agentPage, profile] = await Promise.all([
    audit.listAgentActionsForSpace(db, userId, day.spaceId, { limit: 30 }),
    users.findPlanningProfile(db, userId),
  ]);

  const now = clock.now();
  const isToday = toCalendarDate(now, day.timeZone) === date;
  const nowMinute = isToday ? minuteOfDayAt(now, day.timeZone) : null;

  return {
    day,
    autonomy: profile?.planningPreferences?.autonomyLevel ?? 'ASK_BEFORE_CHANGING',
    agentActions: agentPage.items.map(toAgentActionView),
    isToday,
    nowMinute,
  };
};

export type { DayState, TimeZone };
