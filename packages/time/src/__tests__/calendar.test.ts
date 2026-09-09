import { describe, expect, it } from 'vitest';

import {
  addCalendarDays,
  asCalendarDate,
  asTimeZone,
  calendarDateLengthMinutes,
  calendarDateRange,
  fromDatabaseDate,
  instantAtLocalTime,
  isCalendarDate,
  isValidTimeZone,
  minuteOfDayAt,
  offsetMinutesAt,
  startOfCalendarDate,
  toCalendarDate,
  toDatabaseDate,
} from '../calendar';

describe('timezone validation', () => {
  it.each(['UTC', 'Europe/Lisbon', 'Asia/Kolkata', 'America/New_York'])('accepts %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
    expect(asTimeZone(zone)).toBe(zone);
  });

  it.each(['Mars/Olympus_Mons', 'GMT+5', ''])('rejects %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
    expect(() => asTimeZone(zone)).toThrow(RangeError);
  });
});

describe('calendar date validation', () => {
  it('accepts a real date', () => {
    expect(isCalendarDate('2026-03-29')).toBe(true);
    expect(asCalendarDate('2028-02-29')).toBe('2028-02-29');
  });

  it.each(['2026-02-30', '2026-13-01', '2026-3-1', '20260301', ''])('rejects %s', (value) => {
    expect(isCalendarDate(value)).toBe(false);
    expect(() => asCalendarDate(value)).toThrow(RangeError);
  });
});

describe('toCalendarDate', () => {
  it('resolves the same instant to different days in different zones', () => {
    // 2026-03-28 20:00 UTC is already the 29th in India and still the 28th in New York.
    const instant = new Date('2026-03-28T20:00:00.000Z');

    expect(toCalendarDate(instant, 'Asia/Kolkata')).toBe('2026-03-29');
    expect(toCalendarDate(instant, 'America/New_York')).toBe('2026-03-28');
    expect(toCalendarDate(instant, 'UTC')).toBe('2026-03-28');
  });

  it('does not consult the host timezone', () => {
    const instant = new Date('2026-01-01T12:00:00.000Z');

    expect(toCalendarDate(instant, 'UTC')).toBe('2026-01-01');
  });
});

describe('startOfCalendarDate', () => {
  it('anchors midnight in the user zone, not UTC', () => {
    expect(startOfCalendarDate('2026-03-29', 'Asia/Kolkata').toISOString()).toBe(
      '2026-03-28T18:30:00.000Z',
    );
    expect(startOfCalendarDate('2026-01-15', 'America/New_York').toISOString()).toBe(
      '2026-01-15T05:00:00.000Z',
    );
    expect(startOfCalendarDate('2026-06-15', 'UTC').toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });

  it('round-trips with toCalendarDate', () => {
    for (const zone of ['UTC', 'Asia/Kolkata', 'America/New_York', 'Europe/Lisbon']) {
      const date = asCalendarDate('2026-03-29');
      expect(toCalendarDate(startOfCalendarDate(date, zone), zone)).toBe(date);
    }
  });
});

describe('daylight saving transitions', () => {
  // Europe/Lisbon springs forward at 01:00 on 2026-03-29 (UTC+0 -> UTC+1),
  // making that calendar day 23 hours long.
  it('covers a short day exactly once, with no gap or overlap', () => {
    const { start, end } = calendarDateRange('2026-03-29', 'Europe/Lisbon');

    expect(start.toISOString()).toBe('2026-03-29T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-29T23:00:00.000Z');
    expect(calendarDateLengthMinutes('2026-03-29', 'Europe/Lisbon')).toBe(23 * 60);
  });

  it('covers a long day when the clocks go back', () => {
    // Europe/Lisbon falls back at 02:00 on 2026-10-25: a 25 hour day.
    expect(calendarDateLengthMinutes('2026-10-25', 'Europe/Lisbon')).toBe(25 * 60);
  });

  it('keeps ordinary days at 24 hours', () => {
    expect(calendarDateLengthMinutes('2026-06-15', 'Europe/Lisbon')).toBe(24 * 60);
    expect(calendarDateLengthMinutes('2026-03-29', 'Asia/Kolkata')).toBe(24 * 60);
  });

  it('reports the offset in force at a given instant', () => {
    expect(offsetMinutesAt(new Date('2026-01-15T12:00:00.000Z'), 'Europe/Lisbon')).toBe(0);
    expect(offsetMinutesAt(new Date('2026-06-15T12:00:00.000Z'), 'Europe/Lisbon')).toBe(60);
    expect(offsetMinutesAt(new Date('2026-06-15T12:00:00.000Z'), 'Asia/Kolkata')).toBe(330);
    expect(offsetMinutesAt(new Date('2026-01-15T12:00:00.000Z'), 'America/New_York')).toBe(-300);
  });

  it('shifts a skipped local time forward by the length of the gap', () => {
    // 01:30 local never happens in Lisbon on 2026-03-29; it becomes 02:30.
    const instant = instantAtLocalTime('2026-03-29', 90, 'Europe/Lisbon');

    expect(instant.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(minuteOfDayAt(instant, 'Europe/Lisbon')).toBe(150);
  });

  it('resolves a repeated local time to the later occurrence', () => {
    // 01:30 local happens twice in Lisbon on 2026-10-25. Pinning one side keeps
    // a reminder from firing twice.
    const instant = instantAtLocalTime('2026-10-25', 90, 'Europe/Lisbon');

    expect(instant.toISOString()).toBe('2026-10-25T01:30:00.000Z');
    expect(offsetMinutesAt(instant, 'Europe/Lisbon')).toBe(0);
    expect(minuteOfDayAt(instant, 'Europe/Lisbon')).toBe(90);
  });
});

describe('instantAtLocalTime', () => {
  it('places a wall-clock preference correctly in the user zone', () => {
    // 08:30 local in India on 2026-03-29 is 03:00 UTC.
    expect(instantAtLocalTime('2026-03-29', 8 * 60 + 30, 'Asia/Kolkata').toISOString()).toBe(
      '2026-03-29T03:00:00.000Z',
    );
  });

  it('round-trips through minuteOfDayAt', () => {
    const instant = instantAtLocalTime('2026-07-04', 17 * 60 + 45, 'America/New_York');

    expect(minuteOfDayAt(instant, 'America/New_York')).toBe(17 * 60 + 45);
  });

  it('rejects an out-of-range minute', () => {
    expect(() => instantAtLocalTime('2026-03-29', 1440, 'UTC')).toThrow(RangeError);
    expect(() => instantAtLocalTime('2026-03-29', -1, 'UTC')).toThrow(RangeError);
    expect(() => instantAtLocalTime('2026-03-29', 10.5, 'UTC')).toThrow(RangeError);
  });
});

describe('addCalendarDays', () => {
  it('crosses months, years and leap days without a timezone', () => {
    expect(addCalendarDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addCalendarDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('database date encoding', () => {
  it('encodes to midnight UTC so no local offset can leak in', () => {
    expect(toDatabaseDate('2026-03-29').toISOString()).toBe('2026-03-29T00:00:00.000Z');
  });

  it('round-trips', () => {
    for (const date of ['2026-01-01', '2026-03-29', '2026-12-31', '2028-02-29']) {
      expect(fromDatabaseDate(toDatabaseDate(date))).toBe(date);
    }
  });

  it('decodes using UTC fields, never local ones', () => {
    expect(fromDatabaseDate(new Date('2026-03-29T00:00:00.000Z'))).toBe('2026-03-29');
  });
});
