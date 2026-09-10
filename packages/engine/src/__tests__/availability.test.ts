import { describe, it, expect } from 'vitest';
import { computeAvailability, findSlotsForTask } from '../availability';
import type { PlanningInput } from '../types';
import type { CalendarDate, TimeZone, DurationMinutes, Weekday } from '@space/types';

const DATE = '2026-09-07' as CalendarDate;
const TZ = 'UTC' as TimeZone;

function makeInput(overrides: Partial<PlanningInput> = {}): PlanningInput {
  return {
    userId: 'user-1',
    date: DATE,
    timeZone: TZ,
    planningPreferences: {
      defaultTaskDurationMinutes: 30 as DurationMinutes,
      preferredPlanningMinute: null,
      schedulingStrategy: 'BALANCED',
      autonomyLevel: 'AUTOMATICALLY_MANAGE',
      maxDailyFocusMinutes: 480 as DurationMinutes,
      minBreakMinutes: 0 as DurationMinutes,
      bufferMinutes: 0 as DurationMinutes,
      allowWeekendScheduling: false,
    },
    workingHours: [],
    tasks: [],
    calendarEvents: [],
    reminders: [],
    dependencies: [],
    existingItems: [],
    space: { id: 'space-1', planVersion: 1, status: 'DRAFT' },
    ...overrides,
  };
}

function workBlock(weekday: Weekday, startMinute: number, endMinute: number) {
  return { weekday, startMinute, endMinute };
}

describe('computeAvailability', () => {
  it('returns empty array when no working hours for the target day', () => {
    const input = makeInput();
    const result = computeAvailability(input);
    expect(result).toEqual([]);
  });

  it('returns a single slot for a 9:00–17:00 block (480 min)', () => {
    const input = makeInput({
      workingHours: [workBlock('MONDAY', 540, 1020)],
    });

    const result = computeAvailability(input);

    expect(result).toHaveLength(1);
    expect(result[0]!.durationMinutes).toBe(480);
    expect(result[0]!.start.getUTCHours()).toBe(9);
    expect(result[0]!.end.getUTCHours()).toBe(17);
  });

  it('returns two slots when there is a lunch gap (9–12, 13–17)', () => {
    const input = makeInput({
      workingHours: [workBlock('MONDAY', 540, 720), workBlock('MONDAY', 780, 1020)],
    });

    const result = computeAvailability(input);

    expect(result).toHaveLength(2);
    expect(result[0]!.durationMinutes).toBe(180); // 9:00–12:00
    expect(result[1]!.durationMinutes).toBe(240); // 13:00–17:00
    expect(result[0]!.end.getUTCHours()).toBe(12);
    expect(result[1]!.start.getUTCHours()).toBe(13);
  });

  it('splits slot around a calendar event', () => {
    const input = makeInput({
      workingHours: [workBlock('MONDAY', 540, 1020)],
      calendarEvents: [
        {
          id: 'cal-1',
          startAt: new Date(Date.UTC(2026, 8, 7, 10, 0)),
          endAt: new Date(Date.UTC(2026, 8, 7, 11, 0)),
          isAllDay: false,
          status: 'CONFIRMED',
          title: 'Meeting',
        },
      ],
    });

    const result = computeAvailability(input);

    expect(result).toHaveLength(2);
    expect(result[0]!.durationMinutes).toBe(60); // 9:00–10:00
    expect(result[1]!.durationMinutes).toBe(360); // 11:00–17:00
    expect(result[0]!.end.getUTCHours()).toBe(10);
    expect(result[1]!.start.getUTCHours()).toBe(11);
  });

  it('returns no slots when an all-day event is present', () => {
    const input = makeInput({
      workingHours: [workBlock('MONDAY', 540, 1020)],
      calendarEvents: [
        {
          id: 'cal-allday',
          startAt: new Date(Date.UTC(2026, 8, 7, 0, 0)),
          endAt: new Date(Date.UTC(2026, 8, 7, 23, 59)),
          isAllDay: true,
          status: 'CONFIRMED',
          title: 'Holiday',
        },
      ],
    });

    const result = computeAvailability(input);
    expect(result).toEqual([]);
  });

  it('excludes existing SpaceItems from availability', () => {
    const input = makeInput({
      workingHours: [workBlock('MONDAY', 540, 1020)],
      existingItems: [
        {
          id: 'item-1',
          kind: 'TASK',
          position: 0,
          scheduledStart: new Date(Date.UTC(2026, 8, 7, 9, 0)),
          scheduledEnd: new Date(Date.UTC(2026, 8, 7, 10, 30)),
          taskId: 'task-1',
          reminderId: null,
          calendarEventId: null,
        },
      ],
    });

    const result = computeAvailability(input);

    expect(result).toHaveLength(1);
    expect(result[0]!.durationMinutes).toBe(390); // 10:30–17:00 = 6.5 hours
    expect(result[0]!.start.getUTCHours()).toBe(10);
    expect(result[0]!.start.getUTCMinutes()).toBe(30);
  });

  it('ignores cancelled calendar events', () => {
    const input = makeInput({
      workingHours: [workBlock('MONDAY', 540, 1020)],
      calendarEvents: [
        {
          id: 'cal-cancelled',
          startAt: new Date(Date.UTC(2026, 8, 7, 10, 0)),
          endAt: new Date(Date.UTC(2026, 8, 7, 11, 0)),
          isAllDay: false,
          status: 'CANCELLED',
          title: 'Cancelled Meeting',
        },
      ],
    });

    const result = computeAvailability(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.durationMinutes).toBe(480);
  });
});

describe('findSlotsForTask', () => {
  it('filters out slots shorter than task duration', () => {
    const slots = [
      { start: new Date(0), end: new Date(60 * 60_000), durationMinutes: 60 as DurationMinutes },
      { start: new Date(0), end: new Date(30 * 60_000), durationMinutes: 30 as DurationMinutes },
    ];

    const result = findSlotsForTask(slots, 60 as DurationMinutes, 0);

    expect(result).toHaveLength(1);
    expect(result[0]!.durationMinutes).toBe(60);
  });

  it('applies buffer: reduces slot end and duration by bufferMinutes', () => {
    const slots = [
      { start: new Date(0), end: new Date(120 * 60_000), durationMinutes: 120 as DurationMinutes },
    ];

    const result = findSlotsForTask(slots, 60 as DurationMinutes, 15);

    expect(result).toHaveLength(1);
    expect(result[0]!.durationMinutes).toBe(105); // 120 - 15
    expect(result[0]!.end.getTime()).toBe(slots[0]!.end.getTime() - 15 * 60_000);
  });

  it('excludes slots that are too small after buffer is applied', () => {
    const slots = [
      { start: new Date(0), end: new Date(60 * 60_000), durationMinutes: 60 as DurationMinutes },
    ];

    const result = findSlotsForTask(slots, 60 as DurationMinutes, 15);

    // Needed = 60 + 15 = 75, slot has 60 → filtered out
    expect(result).toEqual([]);
  });

  it('does not mutate original slots', () => {
    const original = [
      { start: new Date(0), end: new Date(120 * 60_000), durationMinutes: 120 as DurationMinutes },
    ];
    const copy = [...original];

    findSlotsForTask(original, 60 as DurationMinutes, 15);

    expect(original[0]!.start.getTime()).toBe(copy[0]!.start.getTime());
    expect(original[0]!.end.getTime()).toBe(copy[0]!.end.getTime());
    expect(original[0]!.durationMinutes).toBe(copy[0]!.durationMinutes);
  });
});
