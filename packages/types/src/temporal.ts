import type { Brand } from './brand';

/**
 * An RFC 3339 / ISO 8601 timestamp that carries an explicit UTC offset.
 *
 * Space stores every instant in UTC. A wall-clock string without an offset is
 * ambiguous and is rejected at the boundary, because the scheduling engines must
 * be able to order instants across timezones and DST transitions.
 *
 * @example '2026-03-29T01:30:00.000Z'
 */
export type IsoDateTime = Brand<string, 'IsoDateTime'>;

/**
 * A calendar date with no time and no offset, formatted `YYYY-MM-DD`.
 *
 * This is the type of "the day a Space belongs to". A calendar date is only
 * meaningful together with a timezone: `2026-03-29` in `Europe/Lisbon` and in
 * `Asia/Kolkata` cover different instants. It is deliberately *not* an instant,
 * so it can never be shifted by a server's local timezone.
 *
 * @example '2026-03-29'
 */
export type CalendarDate = Brand<string, 'CalendarDate'>;

/**
 * A time of day, expressed as whole minutes elapsed since local midnight (0-1439).
 *
 * Preferences such as "remind me at 08:30" are wall-clock intentions, not
 * instants: they must survive DST transitions and a change of timezone. Storing
 * them as minutes avoids attaching a meaningless date to a time of day.
 */
export type MinuteOfDay = Brand<number, 'MinuteOfDay'>;

/**
 * An IANA timezone identifier, e.g. `'Europe/Lisbon'`.
 *
 * Timezones are stored as identifiers rather than fixed offsets so that DST
 * rules are resolved at evaluation time instead of at write time.
 */
export type TimeZone = Brand<string, 'TimeZone'>;

/** A non-negative, whole number of minutes. */
export type DurationMinutes = Brand<number, 'DurationMinutes'>;

/** Minutes east of UTC, as reported for a specific instant in a specific zone. */
export type UtcOffsetMinutes = Brand<number, 'UtcOffsetMinutes'>;

/** Minutes in a day. Used to bound {@link MinuteOfDay}. */
export const MINUTES_PER_DAY = 1440;
