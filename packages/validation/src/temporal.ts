import { isCalendarDate, isValidTimeZone } from '@space/time';
import type {
  CalendarDate,
  DurationMinutes,
  IsoDateTime,
  MinuteOfDay,
  TimeZone,
  UtcOffsetMinutes,
} from '@space/types';
import { MINUTES_PER_DAY } from '@space/types';
import { z } from 'zod';

/**
 * RFC 3339 timestamps with an explicit offset (`Z` or `±HH:MM`).
 *
 * Offsetless wall-clock strings are rejected: Space stores instants, and an
 * instant without an offset cannot be ordered against another one.
 */
const RFC_3339_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Rejects calendar dates that do not exist, such as `2026-02-30`.
 *
 * `Date.parse` is not sufficient on its own: V8 silently rolls an out-of-range
 * day over into the next month, so `2026-02-30` would parse as 2 March and a
 * corrupt date would be accepted at the boundary.
 */
const hasRealCalendarDate = (value: string): boolean => isCalendarDate(value.slice(0, 10));

export const isoDateTimeSchema = z
  .string()
  .regex(RFC_3339_WITH_OFFSET, {
    message: 'must be an RFC 3339 timestamp with an explicit UTC offset',
  })
  .refine((value) => !Number.isNaN(Date.parse(value)) && hasRealCalendarDate(value), {
    message: 'must be a real calendar date',
  })
  .transform((value) => value as IsoDateTime);

/**
 * A `YYYY-MM-DD` calendar date.
 *
 * Used for anything that names a *day* rather than an instant: the date a Space
 * belongs to, a goal's target date, a productivity snapshot.
 */
export const calendarDateSchema = z
  .string()
  .refine(isCalendarDate, { message: 'must be a real YYYY-MM-DD calendar date' })
  .transform((value) => value as CalendarDate);

export const timeZoneSchema = z
  .string()
  .refine(isValidTimeZone, { message: 'must be an IANA timezone identifier' })
  .transform((value) => value as TimeZone);

/** A wall-clock time of day, as minutes since local midnight. */
export const minuteOfDaySchema = z
  .number()
  .int({ message: 'must be a whole number of minutes' })
  .min(0)
  .max(MINUTES_PER_DAY - 1, { message: `must be less than ${MINUTES_PER_DAY}` })
  .transform((value) => value as MinuteOfDay);

export const durationMinutesSchema = z
  .number()
  .int({ message: 'must be a whole number of minutes' })
  .nonnegative({ message: 'must not be negative' })
  .transform((value) => value as DurationMinutes);

export const utcOffsetMinutesSchema = z
  .number()
  .int()
  .min(-12 * 60)
  .max(14 * 60)
  .transform((value) => value as UtcOffsetMinutes);

/** An instant. Accepts a `Date` or an RFC 3339 string, and always yields a `Date`. */
export const instantSchema = z.union([
  z.date(),
  isoDateTimeSchema.transform((value) => new Date(value)),
]);
