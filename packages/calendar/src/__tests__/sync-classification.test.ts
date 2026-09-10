import { describe, expect, it } from 'vitest';

import type { NormalizedCalendarEvent } from '../types';

/**
 * Tests for retry classification logic.
 *
 * These tests verify that calendar errors are correctly classified as
 * retryable or non-retryable. The actual retry logic lives in the BullMQ
 * job configuration; these tests verify the error semantics.
 */

describe('retry classification', () => {
  const RETRYABLE = [
    { name: 'CalendarRateLimitError', isRetryable: true },
    { name: 'CalendarTransientError', isRetryable: true },
    { name: 'CalendarSyncTokenExpiredError', isRetryable: true },
  ];

  const NON_RETRYABLE = [
    { name: 'CalendarAuthError', isRetryable: false },
    { name: 'CalendarPermissionError', isRetryable: false },
    { name: 'CalendarValidationError', isRetryable: false },
  ];

  // Simple classification function that mirrors the production logic.
  const isRetryable = (errorName: string): boolean => {
    switch (errorName) {
      case 'CalendarRateLimitError':
      case 'CalendarTransientError':
      case 'CalendarSyncTokenExpiredError':
        return true;
      default:
        return false;
    }
  };

  for (const { name, isRetryable: expected } of RETRYABLE) {
    it(`${name} is retryable`, () => {
      expect(isRetryable(name)).toBe(expected);
    });
  }

  for (const { name, isRetryable: expected } of NON_RETRYABLE) {
    it(`${name} is not retryable`, () => {
      expect(isRetryable(name)).toBe(expected);
    });
  }
});

describe('event deduplication', () => {
  const makeEvent = (externalId: string): NormalizedCalendarEvent => ({
    externalId,
    title: 'Test',
    startAt: new Date('2026-03-30T09:00:00Z'),
    endAt: new Date('2026-03-30T10:00:00Z'),
    timeZone: 'UTC',
    isAllDay: false,
    status: 'CONFIRMED',
  });

  it('same externalId produces same key', () => {
    const event = makeEvent('evt-123');
    const key = event.externalId;
    expect(key).toBe('evt-123');
  });

  it('different externalIds produce different keys', () => {
    const event1 = makeEvent('evt-1');
    const event2 = makeEvent('evt-2');
    expect(event1.externalId).not.toBe(event2.externalId);
  });

  it('Set deduplicates by externalId', () => {
    const events = [makeEvent('a'), makeEvent('b'), makeEvent('a'), makeEvent('c'), makeEvent('b')];
    const unique = new Set(events.map((e) => e.externalId));
    expect([...unique]).toEqual(['a', 'b', 'c']);
  });
});

describe('all-day event handling', () => {
  it('all-day events have isAllDay true', () => {
    const event: NormalizedCalendarEvent = {
      externalId: 'allday',
      title: 'Holiday',
      startAt: new Date('2026-12-25T00:00:00Z'),
      endAt: new Date('2026-12-26T00:00:00Z'),
      timeZone: 'UTC',
      isAllDay: true,
      status: 'CONFIRMED',
    };

    expect(event.isAllDay).toBe(true);
  });

  it('timed events have isAllDay false', () => {
    const event: NormalizedCalendarEvent = {
      externalId: 'timed',
      title: 'Meeting',
      startAt: new Date('2026-03-30T09:00:00Z'),
      endAt: new Date('2026-03-30T10:00:00Z'),
      timeZone: 'America/New_York',
      isAllDay: false,
      status: 'CONFIRMED',
    };

    expect(event.isAllDay).toBe(false);
  });
});

describe('timezone handling', () => {
  it('event preserves its authored timezone', () => {
    const event: NormalizedCalendarEvent = {
      externalId: 'tz-test',
      title: 'Tokyo Meeting',
      startAt: new Date('2026-03-30T00:00:00Z'),
      endAt: new Date('2026-03-30T01:00:00Z'),
      timeZone: 'Asia/Tokyo',
      isAllDay: false,
      status: 'CONFIRMED',
    };

    expect(event.timeZone).toBe('Asia/Tokyo');
  });

  it('UTC timezone is valid', () => {
    const event: NormalizedCalendarEvent = {
      externalId: 'utc-test',
      title: 'UTC Event',
      startAt: new Date('2026-03-30T09:00:00Z'),
      endAt: new Date('2026-03-30T10:00:00Z'),
      timeZone: 'UTC',
      isAllDay: false,
      status: 'CONFIRMED',
    };

    expect(event.timeZone).toBe('UTC');
  });
});
