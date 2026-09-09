import {
  MINUTES_PER_DAY,
  type CalendarDate,
  type MinuteOfDay,
  type TimeZone,
  type UtcOffsetMinutes,
} from '@space/types';

/**
 * Timezone-aware calendar arithmetic, built on the platform's IANA database.
 *
 * `Intl` is used deliberately instead of a date library: the rules it applies
 * ship with the runtime, are updated with it, and cost no bundle weight. Nothing
 * here reads the host's timezone — every function takes the zone explicitly, so
 * a server in one region can never reinterpret a user's day.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const cached = formatterCache.get(timeZone);
  if (cached) {
    return cached;
  }

  // Constructing a DateTimeFormat is expensive relative to formatting, and the
  // scheduling engines will format many instants per request.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  formatterCache.set(timeZone, formatter);
  return formatter;
};

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const localPartsAt = (instant: Date, timeZone: string): LocalParts => {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? 0 : Number.parseInt(part.value, 10);
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
};

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

/** True when `value` is an IANA zone this runtime knows. */
export const isValidTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/** Narrows a string to {@link TimeZone}, throwing when the zone is unknown. */
export const asTimeZone = (value: string): TimeZone => {
  if (!isValidTimeZone(value)) {
    throw new RangeError(`Unknown IANA timezone: ${value}`);
  }
  return value as TimeZone;
};

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True when `value` is a real `YYYY-MM-DD` date (rejects `2026-02-30`). */
export const isCalendarDate = (value: string): boolean => {
  if (!CALENDAR_DATE_PATTERN.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }

  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
};

/** Narrows a string to {@link CalendarDate}, throwing when it is not a real date. */
export const asCalendarDate = (value: string): CalendarDate => {
  if (!isCalendarDate(value)) {
    throw new RangeError(`Not a valid YYYY-MM-DD calendar date: ${value}`);
  }
  return value as CalendarDate;
};

/**
 * The calendar date an instant falls on, in the given zone.
 *
 * This is the only correct way to answer "which Space does this belong to".
 */
export const toCalendarDate = (instant: Date, timeZone: TimeZone | string): CalendarDate => {
  const { year, month, day } = localPartsAt(instant, timeZone);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}` as CalendarDate;
};

/** Minutes east of UTC that `timeZone` was observing at `instant`. */
export const offsetMinutesAt = (instant: Date, timeZone: TimeZone | string): UtcOffsetMinutes => {
  const { year, month, day, hour, minute, second } = localPartsAt(instant, timeZone);
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  // Instant milliseconds are dropped by the formatter, so compare whole seconds.
  const instantSeconds = Math.floor(instant.getTime() / 1000) * 1000;

  return ((asIfUtc - instantSeconds) / 60_000) as UtcOffsetMinutes;
};

/** The local time of day, in minutes since midnight, at `instant`. */
export const minuteOfDayAt = (instant: Date, timeZone: TimeZone | string): MinuteOfDay => {
  const { hour, minute } = localPartsAt(instant, timeZone);
  return (hour * 60 + minute) as MinuteOfDay;
};

/**
 * The instant at which a local wall-clock time occurs.
 *
 * Resolved in two passes because the offset depends on the very instant being
 * computed: the first pass guesses using the offset near the target, the second
 * corrects it.
 *
 * Daylight saving edges are resolved deterministically, and the choices are
 * pinned by tests:
 *
 * - **Gap** (a local time that never happens, e.g. 01:30 on a spring-forward
 *   day): the wall time is shifted forward by the length of the gap, so 01:30
 *   becomes 02:30 local. This matches `Temporal`'s `compatible` disambiguation.
 * - **Ambiguity** (a local time that happens twice on a fall-back day): the
 *   *later*, post-transition occurrence is chosen. Picking one side
 *   consistently matters more than which side: a reminder must fire once.
 */
export const instantAtLocalTime = (
  date: CalendarDate | string,
  minuteOfDay: number,
  timeZone: TimeZone | string,
): Date => {
  const calendarDate = asCalendarDate(date);

  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay >= MINUTES_PER_DAY) {
    throw new RangeError(
      `minuteOfDay must be an integer in [0, ${MINUTES_PER_DAY}): ${minuteOfDay}`,
    );
  }

  const [year, month, day] = calendarDate.split('-').map(Number) as [number, number, number];
  const wallClockAsUtc = Date.UTC(year, month - 1, day, 0, minuteOfDay, 0);

  let instant = new Date(wallClockAsUtc);
  for (let pass = 0; pass < 2; pass += 1) {
    const offset = offsetMinutesAt(instant, timeZone);
    instant = new Date(wallClockAsUtc - offset * 60_000);
  }

  return instant;
};

/** The first instant of a calendar date in the given zone. */
export const startOfCalendarDate = (
  date: CalendarDate | string,
  timeZone: TimeZone | string,
): Date => instantAtLocalTime(date, 0, timeZone);

/** The calendar date `days` after `date`. Pure string arithmetic — no timezone involved. */
export const addCalendarDays = (date: CalendarDate | string, days: number): CalendarDate => {
  const [year, month, day] = asCalendarDate(date).split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));

  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(
    shifted.getUTCDate(),
  )}` as CalendarDate;
};

/**
 * The half-open instant range `[start, end)` covering a calendar date.
 *
 * The end is the *start of the next day*, not "23:59:59", so a DST day that is
 * 23 or 25 hours long is still covered exactly once with no gap or overlap.
 */
export const calendarDateRange = (
  date: CalendarDate | string,
  timeZone: TimeZone | string,
): { start: Date; end: Date } => ({
  start: startOfCalendarDate(date, timeZone),
  end: startOfCalendarDate(addCalendarDays(date, 1), timeZone),
});

/** Whole minutes between the start and end of a calendar date (DST-aware). */
export const calendarDateLengthMinutes = (
  date: CalendarDate | string,
  timeZone: TimeZone | string,
): number => {
  const { start, end } = calendarDateRange(date, timeZone);
  return Math.round((end.getTime() - start.getTime()) / 60_000);
};

/**
 * Encodes a calendar date for a PostgreSQL `date` column.
 *
 * The driver represents `date` as a `Date` pinned to midnight UTC. Building it
 * with `Date.UTC` keeps the value free of any local-timezone influence; reading
 * it back must use {@link fromDatabaseDate}, never local getters.
 */
export const toDatabaseDate = (date: CalendarDate | string): Date => {
  const [year, month, day] = asCalendarDate(date).split('-').map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, day));
};

/** Decodes a PostgreSQL `date` column back into a calendar date. */
export const fromDatabaseDate = (value: Date): CalendarDate =>
  `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(
    value.getUTCDate(),
  )}` as CalendarDate;
