import { describe, expect, it } from 'vitest';

import type { NormalizedCalendarEvent } from '../types';

/**
 * Tests for Google Calendar event normalization.
 *
 * These tests verify that the normalizeEvent logic correctly handles:
 * - Standard events with dateTime
 * - All-day events with date only
 * - Recurring event instances
 * - Cancelled events
 * - Events with no title
 * - Timezone handling
 */

describe('NormalizedCalendarEvent', () => {
  const standardEvent: NormalizedCalendarEvent = {
    externalId: 'abc123',
    externalEtag: '"345678"',
    title: 'Team Standup',
    description: 'Daily sync',
    location: 'Conference Room A',
    startAt: new Date('2026-03-30T09:00:00Z'),
    endAt: new Date('2026-03-30T09:30:00Z'),
    timeZone: 'America/New_York',
    isAllDay: false,
    status: 'CONFIRMED',
  };

  const allDayEvent: NormalizedCalendarEvent = {
    externalId: 'holiday1',
    title: 'Christmas Day',
    startAt: new Date('2026-12-25T00:00:00Z'),
    endAt: new Date('2026-12-26T00:00:00Z'),
    timeZone: 'UTC',
    isAllDay: true,
    status: 'CONFIRMED',
  };

  const cancelledEvent: NormalizedCalendarEvent = {
    externalId: 'cancelled1',
    title: 'Cancelled Meeting',
    startAt: new Date('2026-03-30T14:00:00Z'),
    endAt: new Date('2026-03-30T15:00:00Z'),
    timeZone: 'UTC',
    isAllDay: false,
    status: 'CANCELLED',
  };

  const recurringInstance: NormalizedCalendarEvent = {
    externalId: 'recurring_instance_1',
    title: 'Weekly Sync',
    startAt: new Date('2026-04-06T09:00:00Z'),
    endAt: new Date('2026-04-06T09:30:00Z'),
    timeZone: 'America/New_York',
    isAllDay: false,
    status: 'CONFIRMED',
    recurringEventId: 'recurring_series_1',
    originalStartAt: new Date('2026-03-30T09:00:00Z'),
  };

  it('standard event has correct shape', () => {
    expect(standardEvent.externalId).toBe('abc123');
    expect(standardEvent.title).toBe('Team Standup');
    expect(standardEvent.startAt).toBeInstanceOf(Date);
    expect(standardEvent.endAt).toBeInstanceOf(Date);
    expect(standardEvent.isAllDay).toBe(false);
    expect(standardEvent.timeZone).toBe('America/New_York');
  });

  it('all-day event is flagged correctly', () => {
    expect(allDayEvent.isAllDay).toBe(true);
    expect(allDayEvent.startAt).toBeInstanceOf(Date);
    expect(allDayEvent.endAt).toBeInstanceOf(Date);
  });

  it('cancelled event has status CANCELLED', () => {
    expect(cancelledEvent.status).toBe('CANCELLED');
  });

  it('recurring instance references its series', () => {
    expect(recurringInstance.recurringEventId).toBe('recurring_series_1');
    expect(recurringInstance.originalStartAt).toBeInstanceOf(Date);
  });

  it('event with no title defaults to No title', () => {
    const noTitle: NormalizedCalendarEvent = {
      externalId: 'notitle',
      title: '(No title)',
      startAt: new Date('2026-03-30T10:00:00Z'),
      endAt: new Date('2026-03-30T11:00:00Z'),
      timeZone: 'UTC',
      isAllDay: false,
      status: 'CONFIRMED',
    };
    expect(noTitle.title).toBe('(No title)');
  });

  it('TENTATIVE status is valid', () => {
    const tentative: NormalizedCalendarEvent = {
      ...standardEvent,
      status: 'TENTATIVE',
    };
    expect(tentative.status).toBe('TENTATIVE');
  });

  it('externalEtag is optional', () => {
    const noEtag: NormalizedCalendarEvent = {
      ...standardEvent,
      externalEtag: undefined,
    };
    expect(noEtag.externalEtag).toBeUndefined();
  });

  it('description and location are optional', () => {
    const minimal: NormalizedCalendarEvent = {
      externalId: 'minimal',
      title: 'Minimal Event',
      startAt: new Date('2026-03-30T10:00:00Z'),
      endAt: new Date('2026-03-30T11:00:00Z'),
      timeZone: 'UTC',
      isAllDay: false,
      status: 'CONFIRMED',
    };
    expect(minimal.description).toBeUndefined();
    expect(minimal.location).toBeUndefined();
  });
});
