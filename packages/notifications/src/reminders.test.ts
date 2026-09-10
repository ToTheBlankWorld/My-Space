import { createLogger } from '@space/logger';
import { FixedClock } from '@space/time';
import { describe, expect, it } from 'vitest';

import { dispatchReminders } from './reminders';
import { REMINDER_OCCURRENCE_KEY } from './keys';
import {
  seedReminder,
  seedTask,
  seedUser,
  updateUserPreferences,
  type SeedReminderOptions,
} from './testing/seed';
import { createFakeDatabase, type FakeDatabaseHandle } from './testing/fake-database';

const USER = 'usr-remind-0000000000001';
const REMINDER = 'rem-000001';
const NOW = '2026-09-10T12:00:00.000Z';

const testLogger = () =>
  createLogger({ name: 'notifications-test', level: 'fatal', destination: { write: () => {} } });

const makeDeps = (handle: FakeDatabaseHandle) => ({
  db: handle.db,
  clock: new FixedClock(NOW),
  logger: testLogger(),
  appUrl: 'https://space.example.com',
});

const base = (handle: FakeDatabaseHandle): FakeDatabaseHandle => {
  seedUser(handle, { id: USER, email: 'user@example.com' });
  return handle;
};

const reminderRow = (): SeedReminderOptions => ({
  id: REMINDER,
  userId: USER,
  title: 'Standup',
  remindAt: new Date('2026-09-10T09:00:00.000Z'),
  timeZone: 'UTC',
});

describe('dispatchReminders', () => {
  it('dispatches a due reminder into a notification, logs, events and a completed reminder', async () => {
    const handle = base(createFakeDatabase());
    seedReminder(handle, reminderRow());
    const deps = makeDeps(handle);

    const result = await dispatchReminders(deps);

    expect(result).toEqual({ attempted: 1, dispatched: 1, duplicates: 0, skipped: 0 });

    const notifications = handle.rows('notification');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.deliveryKey).toBe(REMINDER_OCCURRENCE_KEY(REMINDER, 1));
    expect(notifications[0]?.type).toBe('TASK_REMINDER');
    expect(notifications[0]?.priority).toBe('NORMAL');
    expect(notifications[0]?.linkUrl).toBe('https://space.example.com/space/2026-09-10');

    expect(handle.rows('reminder')[0]).toMatchObject({
      status: 'COMPLETED',
      deliveryState: 'SENT',
    });

    const emails = handle.rows('emailLog');
    expect(emails).toHaveLength(1);
    expect(emails[0]?.recipient).toBe('user@example.com');
    expect(emails[0]?.template).toBe('task-reminder');

    const events = handle.rows('eventLog');
    expect(events.some((event) => event.eventType === 'REMINDER_TRIGGERED')).toBe(true);
    expect(events.some((event) => event.eventType === 'NOTIFICATION_CREATED')).toBe(true);
  });

  it('escalates a CRITICAL task reminder to IMPORTANT', async () => {
    const handle = base(createFakeDatabase());
    seedTask(handle, { id: 'tsk-crit', userId: USER, title: 'Go/no-go', priority: 'CRITICAL' });
    seedReminder(handle, { ...reminderRow(), taskId: 'tsk-crit' });
    const deps = makeDeps(handle);

    await dispatchReminders(deps);

    expect(handle.rows('notification')[0]?.priority).toBe('IMPORTANT');
  });

  it('skips (and events) a reminder when notifications are disabled', async () => {
    const handle = base(createFakeDatabase());
    updateUserPreferences(handle, USER, { notificationsEnabled: false });
    seedReminder(handle, reminderRow());
    const deps = makeDeps(handle);

    const result = await dispatchReminders(deps);

    expect(result).toEqual({ attempted: 1, dispatched: 0, duplicates: 0, skipped: 1 });
    expect(handle.rows('notification')).toHaveLength(0);
    expect(handle.rows('reminder')[0]).toMatchObject({
      status: 'MISSED',
      deliveryState: 'SKIPPED',
    });
    expect(handle.rows('eventLog').some((event) => event.eventType === 'REMINDER_SKIPPED')).toBe(
      true,
    );
  });

  it('absorbs a restarted reminder whose notification already exists', async () => {
    const handle = base(createFakeDatabase());
    seedReminder(handle, reminderRow());
    // Simulate a previous (crashed) run: notification already created.
    handle.insert('notification', {
      userId: USER,
      type: 'TASK_REMINDER',
      priority: 'NORMAL',
      title: 'Standup',
      body: 'Standup',
      deliveryKey: REMINDER_OCCURRENCE_KEY(REMINDER, 1),
      linkUrl: 'https://space.example.com/space/2026-09-10',
      readAt: null,
      scheduledAt: null,
      deliveryState: 'SENT',
    });
    const deps = makeDeps(handle);

    const result = await dispatchReminders(deps);

    expect(result.duplicates).toBe(1);
    expect(handle.rows('notification')).toHaveLength(1);
    expect(handle.rows('reminder')[0]?.status).toBe('COMPLETED');
  });

  it('leaves future reminders untouched', async () => {
    const handle = base(createFakeDatabase());
    seedReminder(handle, { ...reminderRow(), remindAt: new Date('2026-09-10T18:00:00.000Z') });
    const deps = makeDeps(handle);

    const result = await dispatchReminders(deps);

    expect(result.attempted).toBe(0);
    expect(handle.rows('notification')).toHaveLength(0);
    expect(handle.rows('reminder')[0]?.status).toBe('PENDING');
  });

  it('does not redispatch a reminder already claimed by a concurrent worker', async () => {
    const handle = base(createFakeDatabase());
    seedReminder(handle, { ...reminderRow(), deliveryState: 'QUEUED' });
    const deps = makeDeps(handle);

    const result = await dispatchReminders(deps);

    expect(result.attempted).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(handle.rows('reminder')[0]?.deliveryState).toBe('QUEUED');
  });
});
