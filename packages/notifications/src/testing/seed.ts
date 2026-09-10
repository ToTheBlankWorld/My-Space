import { toDatabaseDate } from '@space/time';
import type { CalendarDate } from '@space/types';

import type { FakeDatabaseHandle, FakeRow } from './fake-database';

/**
 * Seed helpers shared by the notification tests. Rows are inserted raw into the
 * fake store, mirroring the shape Prisma would write.
 */

export interface SeedUserOptions {
  id: string;
  email?: string;
  timeZone?: string;
  notificationsEnabled?: boolean;
  emailNotificationsEnabled?: boolean;
  morningNotificationMinute?: number | null;
  middayNotificationMinute?: number | null;
  eveningNotificationMinute?: number | null;
}

export const seedUser = (handle: FakeDatabaseHandle, options: SeedUserOptions): void => {
  const {
    id,
    email = `${id}@example.com`,
    timeZone = 'UTC',
    notificationsEnabled = true,
    emailNotificationsEnabled = true,
    morningNotificationMinute = null,
    middayNotificationMinute = null,
    eveningNotificationMinute = null,
  } = options;

  handle.insert('user', { id, email });
  handle.insert('userPreferences', {
    userId: id,
    timeZone,
    notificationsEnabled,
    emailNotificationsEnabled,
    morningNotificationMinute,
    middayNotificationMinute,
    eveningNotificationMinute,
  });
};

export const dbDate = (date: CalendarDate | string): Date => toDatabaseDate(date);

/** Mutates a seeded preferences row (rows are shared by reference with the store). */
export const updateUserPreferences = (
  handle: FakeDatabaseHandle,
  userId: string,
  patch: Partial<FakeRow>,
): void => {
  const row = handle.rows('userPreferences').find((candidate) => candidate.userId === userId);
  if (row) {
    Object.assign(row, patch);
  }
};

export const seedSpace = (
  handle: FakeDatabaseHandle,
  overrides: Partial<FakeRow> & { id: string; userId: string; date: Date },
): void => {
  const { id, userId, date, ...rest } = overrides;
  handle.insert('space', {
    id,
    userId,
    date,
    timeZone: 'UTC',
    status: 'ACTIVE',
    plannedAt: null,
    optimizedAt: null,
    planVersion: 0,
    ...rest,
  });
};

export interface SeedTaskOptions {
  id: string;
  userId: string;
  title: string;
  status?: string;
  priority?: string;
  dueAt?: Date | null;
  scheduledStart?: Date | null;
  completedAt?: Date | null;
}

export const seedTask = (handle: FakeDatabaseHandle, options: SeedTaskOptions): void => {
  handle.insert('task', {
    id: options.id,
    userId: options.userId,
    spaceId: null,
    goalId: null,
    title: options.title,
    description: null,
    priority: options.priority ?? 'NORMAL',
    status: options.status ?? 'INBOX',
    estimatedMinutes: 30,
    actualMinutes: null,
    dueAt: options.dueAt ?? null,
    scheduledStart: options.scheduledStart ?? null,
    scheduledEnd: null,
    completedAt: options.completedAt ?? null,
  });
};

export type SeedReminderOptions = {
  id: string;
  userId: string;
  title: string;
  remindAt: Date;
  timeZone?: string;
  status?: string;
  deliveryState?: string;
  description?: string | null;
  taskId?: string | null;
  task?: { id: string; title: string; priority: string } | null;
};

export const seedReminder = (handle: FakeDatabaseHandle, options: SeedReminderOptions): void => {
  handle.insert('reminder', {
    id: options.id,
    userId: options.userId,
    spaceId: null,
    taskId: options.taskId ?? null,
    title: options.title,
    description: options.description ?? null,
    remindAt: options.remindAt,
    timeZone: options.timeZone ?? 'UTC',
    status: options.status ?? 'PENDING',
    deliveryState: options.deliveryState ?? 'PENDING',
    deliveredAt: null,
    failureReason: null,
  });
};
