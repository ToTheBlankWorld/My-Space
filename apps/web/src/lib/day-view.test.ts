import { describe, expect, it } from 'vitest';

import type { DayTimelineItem } from '@space/planning';
import type { CalendarDate } from '@space/types';

import {
  clockTime,
  durationLabel,
  focusMinutes,
  isTodayInZone,
  longDate,
  minuteOf,
  nextDate,
  PLAN_MODE_LABEL,
  previousDate,
  timeOf,
  timelineBounds,
  yearOf,
  AUTONOMY_LABEL,
} from './day-view';

/**
 * Determinism is the product's core guarantee: labels derive from absolute
 * calendar dates and instants rendered in a given timezone, never from the
 * machine running the render. These tests pin the exact outputs so a future
 * refactor cannot silently change what a user sees.
 */

const UTC = 'UTC';
const at = (year: number, monthZero: number, day: number, hour = 0, minute = 0): Date =>
  new Date(Date.UTC(year, monthZero, day, hour, minute));

const on = (value: string): CalendarDate => value as CalendarDate;

describe('timeOf', () => {
  it('renders a dash for missing instants', () => {
    expect(timeOf(null, UTC)).toBe('–');
  });

  it('renders the same instant differently per timezone', () => {
    const instant = at(2026, 8, 10, 10, 0);
    expect(timeOf(instant, UTC)).toBe('10:00');
    expect(timeOf(instant, 'Europe/Lisbon')).toBe('11:00');
    expect(timeOf(instant, 'America/New_York')).toBe('06:00');
    expect(timeOf(instant, 'Asia/Kolkata')).toBe('15:30');
  });
});

describe('calendar-date labels', () => {
  it('formats the absolute calendar date, not an instant', () => {
    expect(longDate(on('2026-09-10'))).toBe('Thursday 10 September');
  });

  it('does not drift across date boundaries', () => {
    expect(longDate(on('2026-01-01'))).toBe('Thursday 1 January');
    expect(longDate(on('2026-12-31'))).toBe('Thursday 31 December');
  });

  it('extracts the year', () => {
    expect(yearOf(on('2026-09-10'))).toBe('2026');
  });
});

describe('day navigation', () => {
  it('steps one calendar day in either direction', () => {
    expect(previousDate(on('2026-09-10'))).toBe('2026-09-09');
    expect(nextDate(on('2026-09-10'))).toBe('2026-09-11');
    expect(nextDate(on('2026-12-31'))).toBe('2027-01-01');
  });
});

describe('isTodayInZone', () => {
  it('judges "today" in the space timezone, never the server timezone', () => {
    const instant = at(2026, 8, 10, 20, 0);
    expect(isTodayInZone(on('2026-09-10'), UTC, instant)).toBe(true);
    expect(isTodayInZone(on('2026-09-10'), 'Pacific/Kiritimati', instant)).toBe(false);
  });
});

describe('minuteOf', () => {
  it('returns minute-of-day in the given timezone', () => {
    expect(minuteOf(at(2026, 8, 10, 10, 0), UTC)).toBe(600);
    expect(minuteOf(at(2026, 8, 10, 10, 0), 'Asia/Kolkata')).toBe(930);
  });
});

describe('durationLabel', () => {
  it('formats minute durations compactly', () => {
    expect(durationLabel(45)).toBe('45m');
    expect(durationLabel(90)).toBe('1h 30m');
    expect(durationLabel(120)).toBe('2h');
    expect(durationLabel(42.4)).toBe('42m');
    expect(durationLabel(0)).toBe('0m');
  });
});

describe('clockTime', () => {
  it('renders minutes since midnight as HH:MM', () => {
    expect(clockTime(0)).toBe('00:00');
    expect(clockTime(590)).toBe('09:50');
    expect(clockTime(1439)).toBe('23:59');
  });

  it('clamps out-of-range minutes', () => {
    expect(clockTime(-5)).toBe('00:00');
    expect(clockTime(1500)).toBe('23:59');
  });
});

describe('timelineBounds', () => {
  it('defaults to a quiet day', () => {
    expect(timelineBounds([], UTC)).toEqual({ startHour: 8, endHour: 18 });
  });

  it('pads around the earliest and latest instants', () => {
    const items: DayTimelineItem[] = [
      {
        kind: 'CALENDAR_EVENT' as const,
        itemId: 'e1',
        title: 'Sync',
        priority: null,
        start: at(2026, 8, 10, 10, 0),
        end: at(2026, 8, 10, 11, 30),
        position: 0,
      },
    ];
    expect(timelineBounds(items, UTC)).toEqual({ startHour: 9, endHour: 13 });
  });
});

describe('focusMinutes', () => {
  it('counts scheduled work but never calendar anchors', () => {
    const items: DayTimelineItem[] = [
      {
        kind: 'TASK' as const,
        itemId: 't1',
        title: 'Write',
        priority: 'HIGH',
        start: at(2026, 8, 10, 9, 0),
        end: at(2026, 8, 10, 10, 0),
        position: 0,
      },
      {
        kind: 'TASK' as const,
        itemId: 't2',
        title: 'Review',
        priority: 'NORMAL',
        start: null,
        end: null,
        position: 0,
      },
      {
        kind: 'CALENDAR_EVENT' as const,
        itemId: 'e1',
        title: 'Sync',
        priority: null,
        start: at(2026, 8, 10, 11, 0),
        end: at(2026, 8, 10, 12, 0),
        position: 0,
      },
    ];
    expect(focusMinutes(items)).toBe(60);
  });
});

describe('shared vocabularies', () => {
  it('labels every plan mode and autonomy level', () => {
    expect(PLAN_MODE_LABEL.applied).toBe('Applied');
    expect(Object.keys(AUTONOMY_LABEL)).toHaveLength(3);
  });
});
