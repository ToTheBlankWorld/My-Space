import { audit, spaces, type Database } from '@space/database';
import { calendarDateRange } from '@space/time';
import type { CalendarDate, TimeZone } from '@space/types';
import { timeZoneSchema } from '@space/validation';

import { planningCompletedPayloadSchema } from './persist';
import { dedupeById } from './snapshot';
import type { DayState, DayLatestPlan, DayTimelineItem } from './types';

/**
 * Reads a day back from the database — the authoritative view the UI renders.
 *
 * Separated from the planning service so both can be tested against the same
 * fake database. The page renders this state; a client refresh after planning
 * re-runs this read, which is why the result always reflects what was actually
 * persisted, not what a request happened to compute.
 */

export interface LoadDayStateArgs {
  userId: string;
  spaceId: string;
  date: CalendarDate;
  timeZone: TimeZone;
  status: DayState['status'];
  planVersion: number;
  plannedAt: Date | null;
  /** Produced by the caller's injected clock, so reads stay deterministic. */
  generatedAt: Date;
}

export interface DayTaskPoolRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  estimatedMinutes: number | null;
}

/**
 * The day's candidate pool — the space's own open tasks plus anything scheduled
 * into or due during the day. Shared with the snapshot loader so the view and a
 * future pass always reason about the same set.
 */
export const loadDayTaskPool = async (
  db: Database,
  {
    userId,
    date,
    timeZone,
    spaceId,
  }: { userId: string; date: CalendarDate; timeZone: TimeZone; spaceId: string },
): Promise<DayTaskPoolRow[]> => {
  const range = calendarDateRange(date, timeZoneSchema.parse(timeZone));

  const rows = await db.task.findMany({
    where: {
      userId,
      OR: [
        { spaceId },
        { scheduledStart: { gte: range.start, lt: range.end } },
        { dueAt: { gte: range.start, lt: range.end } },
      ],
      status: { in: ['INBOX', 'PLANNED', 'IN_PROGRESS'] },
    },
    select: {
      id: true,
      title: true,
      priority: true,
      status: true,
      estimatedMinutes: true,
    },
  });

  return dedupeById(rows);
};

export const loadDayState = async (db: Database, args: LoadDayStateArgs): Promise<DayState> => {
  const { userId, spaceId, date, timeZone, status, planVersion, plannedAt, generatedAt } = args;

  const timeline = await spaces.getSpaceTimeline(db, userId, spaceId);
  const planned: DayTimelineItem[] = timeline.map((item) => ({
    kind: item.kind,
    itemId: item.taskId ?? item.reminderId ?? item.calendarEventId ?? item.id,
    title: item.task?.title ?? item.reminder?.title ?? item.calendarEvent?.title ?? 'Untitled item',
    priority: item.task?.priority ?? null,
    start: item.scheduledStart,
    end: item.scheduledEnd,
    position: item.position,
  }));

  // Calendar events are anchors — the persister never creates SpaceItems for
  // them, so they must be added from the calendar table for the day to render.
  const range = calendarDateRange(date, timeZoneSchema.parse(timeZone));
  const events = await db.calendarEvent.findMany({
    where: {
      userId,
      deletedAt: null,
      startAt: { lt: range.end },
      endAt: { gt: range.start },
      status: { not: 'CANCELLED' },
    },
    select: { id: true, title: true, startAt: true, endAt: true },
  });

  const eventItems: DayTimelineItem[] = events.map((event, index) => ({
    kind: 'CALENDAR_EVENT',
    itemId: event.id,
    title: event.title,
    priority: null,
    start: event.startAt,
    end: event.endAt,
    position: 1_000_000 + index,
  }));

  const combined = [...planned, ...eventItems].sort((a, b) => {
    const aStart = a.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bStart = b.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return aStart - bStart || a.position - b.position;
  });

  const scheduledTaskIds = new Set(
    combined.filter((item) => item.kind === 'TASK').map((item) => item.itemId),
  );

  const pool = await loadDayTaskPool(db, { userId, date, timeZone, spaceId });
  const unscheduled = pool
    .filter((task) => !scheduledTaskIds.has(task.id))
    .map((task) => ({
      id: task.id,
      title: task.title,
      priority: task.priority as DayState['unscheduled'][number]['priority'],
      status: task.status,
      estimatedMinutes: task.estimatedMinutes,
    }));

  const latestPlan = await loadLatestCompletedPlan(db, userId, spaceId);

  return {
    date,
    timeZone,
    spaceId,
    status,
    planVersion,
    plannedAt,
    planned: combined,
    unscheduled,
    latestPlan,
    generatedAt,
  };
};

const loadLatestCompletedPlan = async (
  db: Database,
  userId: string,
  spaceId: string,
): Promise<DayLatestPlan | null> => {
  const events = await audit.listAggregateEvents(db, userId, { aggregateId: spaceId, limit: 200 });

  // The aggregate history is oldest-first; the newest completed pass is the last.
  for (const event of [...events].reverse()) {
    if (event.eventType !== 'PLANNING_COMPLETED') {
      continue;
    }

    const parsed = planningCompletedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      continue;
    }

    // The schema deliberately keeps `type`/`kind`/`reasonCode` as free strings so
    // a future engine reason code never breaks the reader; the branded unions on
    // the view types are enforced at this boundary.
    return {
      mode: parsed.data.mode,
      scheduled: parsed.data.scheduled,
      unscheduled: parsed.data.unscheduled,
      conflicts: parsed.data.conflicts as DayLatestPlan['conflicts'],
      explanations: parsed.data.explanations as DayLatestPlan['explanations'],
      planVersion: parsed.data.planVersion,
      durationMs: parsed.data.durationMs,
    };
  }

  return null;
};
