import { FixedClock, toCalendarDate } from '@space/time';
import { describe, expect, it } from 'vitest';

import { SEED_IDS, SEED_INSTANT, buildSeedData } from '../../prisma/seed-data';

/**
 * The seed must be reproducible without a database.
 *
 * `buildSeedData` is pure, so the properties that matter — determinism, correct
 * per-user timezone handling, no real personal data — are asserted here rather
 * than by eyeballing a seeded database.
 */

const clock = () => new FixedClock(SEED_INSTANT);

describe('seed determinism', () => {
  it('produces identical data on every run', () => {
    expect(buildSeedData(clock())).toEqual(buildSeedData(clock()));
  });

  it('serialises identically, so a diff of two runs is empty', () => {
    expect(JSON.stringify(buildSeedData(clock()))).toBe(JSON.stringify(buildSeedData(clock())));
  });

  it('derives every instant from the injected clock, never the host clock', () => {
    const shifted = buildSeedData(new FixedClock('2027-01-15T09:00:00.000Z'));

    expect(shifted.now.toISOString()).toBe('2027-01-15T09:00:00.000Z');
    // A different "now" moves the data, which proves nothing is hard-coded to a
    // real date and nothing read `Date.now()` behind the clock's back.
    expect(shifted.spaces[1]?.date).toBe('2027-01-15');
  });

  it('uses stable identifiers so a re-run updates rather than duplicates', () => {
    const data = buildSeedData(clock());

    expect(data.users.map((user) => user.id)).toEqual([SEED_IDS.users.ada, SEED_IDS.users.noor]);
    expect(data.spaces.map((space) => space.id)).toEqual([
      SEED_IDS.spaces.adaYesterday,
      SEED_IDS.spaces.adaToday,
      SEED_IDS.spaces.adaTomorrow,
      SEED_IDS.spaces.noorToday,
    ]);
  });

  it('keeps every identifier unique', () => {
    const data = buildSeedData(clock());
    const ids = [
      ...data.users.map((row) => row.id),
      ...data.spaces.map((row) => row.id),
      ...data.tasks.map((row) => row.id),
      ...data.reminders.map((row) => row.id),
      ...data.goals.map((row) => row.id),
      ...data.calendarEvents.map((row) => row.id),
      ...data.notifications.map((row) => row.id),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('seed timezone handling', () => {
  it('anchors each user’s day in their own zone', () => {
    const data = buildSeedData(clock());
    const [ada, noor] = [data.spaces[1], data.spaces[3]];

    expect(ada?.timeZone).toBe('Europe/Lisbon');
    expect(noor?.timeZone).toBe('Asia/Kolkata');
    expect(ada?.date).toBe(toCalendarDate(data.now, 'Europe/Lisbon'));
    expect(noor?.date).toBe(toCalendarDate(data.now, 'Asia/Kolkata'));
  });

  it('places a task at the right instant for the user’s local working hours', () => {
    const data = buildSeedData(clock());
    const noorTask = data.tasks.find((task) => task.id === SEED_IDS.tasks.noorSyllabus);

    // 10:00 in Kolkata is 04:30 UTC.
    expect(noorTask?.scheduledStart?.toISOString()).toBe('2026-03-30T04:30:00.000Z');
  });

  it('produces spaces on three consecutive days for the primary user', () => {
    const data = buildSeedData(clock());

    expect([data.spaces[0]?.date, data.spaces[1]?.date, data.spaces[2]?.date]).toEqual([
      '2026-03-29',
      '2026-03-30',
      '2026-03-31',
    ]);
  });
});

describe('seed content', () => {
  it('covers the states the product has to render', () => {
    const data = buildSeedData(clock());
    const statuses = new Set(data.tasks.map((task) => task.status));
    const priorities = new Set(data.tasks.map((task) => task.priority));

    expect(statuses).toContain('COMPLETED');
    expect(statuses).toContain('IN_PROGRESS');
    expect(statuses).toContain('PLANNED');
    expect(statuses).toContain('MISSED');
    expect(statuses).toContain('INBOX');
    expect(priorities).toEqual(new Set(['CRITICAL', 'HIGH', 'NORMAL', 'LOW']));
  });

  it('includes a recurring and a one-off reminder', () => {
    const data = buildSeedData(clock());

    expect(data.reminders.filter((row) => row.recurrenceFrequency === null)).toHaveLength(1);
    expect(data.reminders.filter((row) => row.recurrenceFrequency === 'WEEKLY')).toHaveLength(1);
  });

  it('includes read and unread notifications', () => {
    const data = buildSeedData(clock());

    expect(data.notifications.some((row) => row.readAt !== null)).toBe(true);
    expect(data.notifications.some((row) => row.readAt === null)).toBe(true);
  });

  it('contains no real personal data', () => {
    // `.test` is reserved by RFC 2606 and can never be a real domain.
    const data = buildSeedData(clock());

    for (const user of data.users) {
      expect(user.email.endsWith('@example.test')).toBe(true);
    }

    const serialised = JSON.stringify(data);
    for (const forbidden of ['@gmail', '@outlook', 'password', 'secret', 'token', 'api_key']) {
      expect(serialised.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('never schedules an interval that ends before it starts', () => {
    const data = buildSeedData(clock());

    for (const task of data.tasks) {
      if (task.scheduledStart && task.scheduledEnd) {
        expect(task.scheduledEnd.getTime()).toBeGreaterThanOrEqual(task.scheduledStart.getTime());
      }
    }

    for (const event of data.calendarEvents) {
      expect(event.endAt.getTime()).toBeGreaterThan(event.startAt.getTime());
    }
  });
});
