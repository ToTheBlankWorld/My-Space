import type { DayTimelineItem, PlanMode } from '@space/planning';
import { addCalendarDays, minuteOfDayAt, toCalendarDate } from '@space/time';
import type { CalendarDate, TimeZone } from '@space/types';

/**
 * Pure, timezone-honest helpers for rendering a day.
 *
 * Dates in a Space are the user's local calendar dates; every `Intl` format
 * here renders against the space's own `timeZone` or formats the date string as
 * an absolute calendar date (UTC discipline), so the header and timeline can
 * never shift because the server sits in another region.
 */

const LOCALE = 'en-GB';

export const timeOf = (value: Date | null, timeZone: string): string => {
  if (!value) {
    return '–';
  }
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
};

const utcDate = (date: string): Date => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
};

/** "Wednesday, 10 September" — the calendar date itself, not an instant. */
export const longDate = (date: CalendarDate): string =>
  new Intl.DateTimeFormat(LOCALE, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(utcDate(date));

/** "2026" from the calendar date. */
export const yearOf = (date: CalendarDate): string => date.split('-')[0] ?? '';

export const previousDate = (date: CalendarDate): CalendarDate => addCalendarDays(date, -1);

export const nextDate = (date: CalendarDate): CalendarDate => addCalendarDays(date, 1);

/** Whether the calendar date is "today" for the space's own timezone. */
export const isTodayInZone = (
  date: CalendarDate,
  timeZone: TimeZone | string,
  now: Date,
): boolean => toCalendarDate(now, timeZone) === date;

/** Minute-of-day (0–1439) of an instant in the space's timezone. */
export const minuteOf = (value: Date, timeZone: TimeZone | string): number =>
  minuteOfDayAt(value, timeZone);

export interface TimelineBounds {
  startHour: number;
  endHour: number;
}

const DEFAULT_BOUNDS: TimelineBounds = { startHour: 8, endHour: 18 };

/**
 * The span of hours the timeline must show to contain every item, padded gently
 * at both ends and clamped to a calendar day.
 */
export const timelineBounds = (
  items: readonly DayTimelineItem[],
  timeZone: TimeZone | string,
): TimelineBounds => {
  const hours = items
    .flatMap((item) => [item.start, item.end])
    .filter((value): value is Date => value !== null)
    .map((value) => minuteOfDayAt(value, timeZone) / 60);

  if (hours.length === 0) {
    return DEFAULT_BOUNDS;
  }

  const startHour = Math.max(0, Math.floor(Math.min(...hours)) - 1);
  const endHour = Math.min(24, Math.ceil(Math.max(...hours)) + 1);

  return { startHour, endHour: Math.max(startHour + 2, endHour) };
};

/** Minutes of focused work placed by the engine (tasks and reminders, never anchors). */
export const focusMinutes = (items: readonly DayTimelineItem[]): number =>
  items.reduce((total, item) => {
    if (item.kind === 'CALENDAR_EVENT' || !item.start || !item.end) {
      return total;
    }
    return total + Math.max(0, (item.end.getTime() - item.start.getTime()) / 60_000);
  }, 0);

/** "1h 30m", "45m" — a compact human duration. */
export const durationLabel = (minutes: number): string => {
  const whole = Math.round(minutes);
  if (whole < 60) {
    return `${whole}m`;
  }
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
};

/** "09:00" from minutes since local midnight (0–1439). */
export const clockTime = (minute: number): string => {
  const safe = Math.min(Math.max(Math.trunc(minute), 0), 1439);
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
};

export const PLAN_MODE_LABEL: Record<PlanMode, string> = {
  applied: 'Applied',
  'ask-before-changing': 'Suggestions only',
  'suggest-only': 'Preview only',
};

export const AUTONOMY_LABEL = {
  SUGGEST_ONLY: 'Suggest only',
  ASK_BEFORE_CHANGING: 'Ask before changing',
  AUTOMATICALLY_MANAGE: 'Automatic',
} as const;

export const AUTONOMY_DESCRIPTION = {
  SUGGEST_ONLY: 'Space suggests a plan and never changes your calendar.',
  ASK_BEFORE_CHANGING: 'Space places new work but asks before moving scheduled items.',
  AUTOMATICALLY_MANAGE: 'Space rebalances your day on its own while honouring what you lock.',
} as const;

export const PRIORITY_LABEL = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  NORMAL: 'Normal',
  LOW: 'Low',
} as const;

/** Default focus-work span shown on a brand-new day, in local hours. */
export const DEFAULT_TIMELINE_HOURS = DEFAULT_BOUNDS;
