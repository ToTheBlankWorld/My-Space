import { FixedClock } from '@space/time';

import { createDatabaseClient, type DatabaseClient } from '../src/client';
import { SEED_INSTANT, buildSeedData, type SeedData } from './seed-data';

/**
 * Applies the development seed.
 *
 * Idempotent: everything is an upsert keyed on a fixed identifier, so running it
 * twice leaves the database in the same state as running it once. That matters
 * because `prisma migrate reset` runs it automatically, and a developer will run
 * it again by hand five minutes later.
 *
 * Time comes from a {@link FixedClock}, never the host clock: seeded data must be
 * identical on every machine and in every run.
 */

const applySeed = async (db: DatabaseClient, data: SeedData): Promise<void> => {
  const seededAt = data.now;

  for (const user of data.users) {
    await db.user.upsert({
      where: { id: user.id },
      create: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: true,
        // Seeded users are treated as fully onboarded so a developer lands on
        // the dashboard rather than the onboarding flow.
        onboardingCompletedAt: seededAt,
      },
      update: { email: user.email, name: user.name },
    });
  }

  for (const preference of data.preferences) {
    await db.userPreferences.upsert({
      where: { userId: preference.userId },
      create: preference,
      update: preference,
    });
  }

  for (const planning of data.planning) {
    await db.planningPreferences.upsert({
      where: { userId: planning.userId },
      create: planning,
      update: planning,
    });
  }

  // Availability is a set: replacing it wholesale keeps a re-run from stacking
  // duplicate blocks.
  await db.workingHoursBlock.deleteMany({
    where: { userId: { in: data.users.map((user) => user.id) } },
  });
  await db.workingHoursBlock.createMany({ data: data.workingHours });

  for (const goal of data.goals) {
    const { targetDate, ...rest } = goal;
    const row = { ...rest, targetDate: new Date(`${targetDate}T00:00:00.000Z`) };
    await db.goal.upsert({ where: { id: goal.id }, create: row, update: row });
  }

  for (const space of data.spaces) {
    const { date, ...rest } = space;
    const row = { ...rest, date: new Date(`${date}T00:00:00.000Z`) };
    await db.space.upsert({ where: { id: space.id }, create: row, update: row });
  }

  for (const task of data.tasks) {
    await db.task.upsert({ where: { id: task.id }, create: task, update: task });
  }

  for (const reminder of data.reminders) {
    await db.reminder.upsert({ where: { id: reminder.id }, create: reminder, update: reminder });
  }

  await db.calendarConnection.upsert({
    where: { id: data.calendarConnection.id },
    create: data.calendarConnection,
    update: data.calendarConnection,
  });

  await db.calendar.upsert({
    where: { id: data.calendar.id },
    create: data.calendar,
    update: data.calendar,
  });

  for (const event of data.calendarEvents) {
    const row = { ...event, provider: 'GOOGLE' as const, lastSyncedAt: seededAt };
    await db.calendarEvent.upsert({ where: { id: event.id }, create: row, update: row });
  }

  for (const notification of data.notifications) {
    const row = {
      ...notification,
      deliveryState: 'SENT' as const,
      sentAt: seededAt,
    };
    await db.notification.upsert({
      where: { id: notification.id },
      create: row,
      update: row,
    });
  }

  for (const snapshot of data.productivity) {
    const { date, userId, ...metrics } = snapshot;
    const row = { ...metrics, computedAt: seededAt };
    await db.productivitySnapshot.upsert({
      where: { userId_date: { userId, date: new Date(`${date}T00:00:00.000Z`) } },
      create: { userId, date: new Date(`${date}T00:00:00.000Z`), ...row },
      update: row,
    });
  }

  // Place the day's items on the timeline in a fixed order.
  const timeline = [
    { kind: 'TASK' as const, id: data.tasks[2]?.id, position: 10 },
    { kind: 'CALENDAR_EVENT' as const, id: data.calendarEvents[0]?.id, position: 20 },
    { kind: 'TASK' as const, id: data.tasks[1]?.id, position: 30 },
    { kind: 'CALENDAR_EVENT' as const, id: data.calendarEvents[1]?.id, position: 40 },
    { kind: 'REMINDER' as const, id: data.reminders[0]?.id, position: 50 },
  ];

  const todaysSpace = data.spaces[1];
  const owner = data.users[0];

  if (todaysSpace && owner) {
    for (const item of timeline) {
      if (!item.id) {
        continue;
      }

      const key =
        item.kind === 'TASK'
          ? { taskId: item.id }
          : item.kind === 'REMINDER'
            ? { reminderId: item.id }
            : { calendarEventId: item.id };

      const row = {
        userId: owner.id,
        spaceId: todaysSpace.id,
        kind: item.kind,
        position: item.position,
        ...key,
      };

      await db.spaceItem.upsert({ where: key, create: row, update: row });
    }
  }
};

const main = async (): Promise<void> => {
  const clock = new FixedClock(SEED_INSTANT);
  const data = buildSeedData(clock);
  const db = createDatabaseClient();

  try {
    // One transaction: a half-applied seed is worse than no seed.
    await db.$transaction(async (tx) => {
      await applySeed(tx as unknown as DatabaseClient, data);
    });

    console.warn(
      `[seed] applied ${data.users.length} users, ${data.spaces.length} spaces, ${data.tasks.length} tasks at ${SEED_INSTANT}`,
    );
  } finally {
    await db.$disconnect();
  }
};

await main();
