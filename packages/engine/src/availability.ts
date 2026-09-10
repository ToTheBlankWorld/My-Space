import type { DurationMinutes } from '@space/types';

import type { AvailableSlot, PlanningInput, TimeBlock } from './types';

/**
 * Computes available time blocks for a planning day.
 *
 * Availability is the intersection of:
 *   1. Working hours for the target day's weekday.
 *   2. Existing calendar events (external, immutable).
 *   3. Existing SpaceItems (rescheduled work, treated as immutable).
 *
 * Output is a sorted list of half-open intervals `[start, end)` where new work
 * can be placed. No block overlaps another; gaps between blocks are free time.
 *
 * Pure function: no side effects, no randomness.
 */
export const computeAvailability = (input: PlanningInput): AvailableSlot[] => {
  const { workingHours, calendarEvents, existingItems, timeZone, date } = input;
  const targetWeekday = getWeekdayFromDate(date);

  // 1. Find working hours for the target weekday.
  const dayBlocks = workingHours.filter((wh) => wh.weekday === targetWeekday);

  if (dayBlocks.length === 0) {
    return [];
  }

  // 2. Build occupied blocks from calendar events and existing items.
  const occupied: TimeBlock[] = [];

  for (const event of calendarEvents) {
    if (event.status === 'CANCELLED') continue;
    if (event.isAllDay) {
      // All-day events occupy the full day range.
      const dayStart = getDayStart(date, timeZone);
      const dayEnd = getDayEnd(date, timeZone);
      occupied.push({
        start: dayStart,
        end: dayEnd,
        immutable: true,
        ownerId: event.id,
        ownerKind: 'CALENDAR_EVENT',
      });
    } else {
      occupied.push({
        start: event.startAt,
        end: event.endAt,
        immutable: true,
        ownerId: event.id,
        ownerKind: 'CALENDAR_EVENT',
      });
    }
  }

  for (const item of existingItems) {
    if (item.scheduledStart && item.scheduledEnd) {
      occupied.push({
        start: item.scheduledStart,
        end: item.scheduledEnd,
        immutable: true,
        ownerId: item.id,
        ownerKind: item.kind,
      });
    }
  }

  // 3. Build available blocks from working hours, then subtract occupied.
  const available: TimeBlock[] = [];

  for (const wh of dayBlocks) {
    const blockStart = minuteOfDayToDate(date, wh.startMinute, timeZone);
    const blockEnd = minuteOfDayToDate(date, wh.endMinute, timeZone);
    available.push({ start: blockStart, end: blockEnd, immutable: false });
  }

  // Sort occupied blocks by start time.
  occupied.sort((a, b) => a.start.getTime() - b.start.getTime());

  // Subtract occupied from available.
  const free: TimeBlock[] = [];

  for (const avail of available) {
    let current = avail;

    for (const occ of occupied) {
      if (occ.end.getTime() <= current.start.getTime()) continue;
      if (occ.start.getTime() >= current.end.getTime()) break;

      // Overlap: split current around the occupied block.
      if (occ.start.getTime() > current.start.getTime()) {
        free.push({ start: current.start, end: occ.start, immutable: false });
      }

      current = {
        start: new Date(Math.max(current.start.getTime(), occ.end.getTime())),
        end: current.end,
        immutable: false,
      };
    }

    if (current.end.getTime() > current.start.getTime()) {
      free.push(current);
    }
  }

  // Convert to AvailableSlot (in minutes for scheduling).
  return free.map((block) => ({
    start: block.start,
    end: block.end,
    durationMinutes: Math.round(
      (block.end.getTime() - block.start.getTime()) / 60_000,
    ) as DurationMinutes,
  }));
};

/**
 * Returns available slots that can fit a task of the given duration.
 *
 * Slots shorter than the task duration are excluded.
 */
export const findSlotsForTask = (
  available: AvailableSlot[],
  taskDurationMinutes: DurationMinutes,
  bufferMinutes: number,
): AvailableSlot[] => {
  const needed = (taskDurationMinutes as number) + bufferMinutes;

  return available
    .filter((slot) => slot.durationMinutes >= needed)
    .map((slot) => ({
      start: new Date(slot.start.getTime()),
      end: new Date(slot.end.getTime() - bufferMinutes * 60_000),
      durationMinutes: (slot.durationMinutes - bufferMinutes) as DurationMinutes,
    }));
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getWeekdayFromDate = (date: string): string => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const d = new Date(Date.UTC(year, month - 1, day));
  const names = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  return names[d.getUTCDay()]!;
};

const minuteOfDayToDate = (date: string, minuteOfDay: number, _timeZone: string): Date => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return new Date(Date.UTC(year, month - 1, day, hours, minutes));
};

const getDayStart = (date: string, _timeZone: string): Date => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day, 0, 0));
};

const getDayEnd = (date: string, _timeZone: string): Date => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 1, 0, 0));
};
