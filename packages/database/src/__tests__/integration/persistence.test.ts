import { FixedClock, toCalendarDate, toDatabaseDate } from '@space/time';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import type { DatabaseClient } from '../../client';
import { InvalidTransitionError, RecordNotFoundError, UniqueConstraintError } from '../../errors';
import * as audit from '../../repositories/audit';
import * as calendar from '../../repositories/calendar';
import * as delivery from '../../repositories/delivery';
import * as spaces from '../../repositories/spaces';
import * as users from '../../repositories/users';
import * as work from '../../repositories/work';
import { checkDatabaseHealth } from '../../health';
import { cleanupTestData, createTestClient, describeIntegration, testEmail } from './setup';

/**
 * Behaviour that only a real database can prove.
 *
 * Time is supplied by a {@link FixedClock} everywhere, so nothing in this file
 * depends on when it runs.
 */

const clock = new FixedClock('2026-03-30T09:00:00.000Z');
const LISBON = 'Europe/Lisbon';
const KOLKATA = 'Asia/Kolkata';

describeIntegration('persistence', () => {
  let db: DatabaseClient;

  const newUser = async (label: string) =>
    users.createUser(db, { email: testEmail(label), name: 'Test Person' });

  beforeAll(() => {
    db = createTestClient();
  });

  beforeEach(async () => {
    await cleanupTestData(db);
  });

  afterAll(async () => {
    await cleanupTestData(db);
    await db.$disconnect();
  });

  it('reports a healthy database', async () => {
    await expect(checkDatabaseHealth(db)).resolves.toMatchObject({ status: 'ok' });
  });

  // ---------------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------------

  it('creates a user and returns only public columns', async () => {
    const user = await newUser('create');

    expect(user.id).toMatch(/^[a-z0-9]{20,}$/);
    expect(user.status).toBe('ACTIVE');
    expect(Object.keys(user).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'imageUrl',
      'name',
      'status',
    ]);
  });

  it('normalises email case, so the unique index cannot be bypassed', async () => {
    const email = testEmail('case');
    await users.createUser(db, { email: email.toUpperCase() });

    await expect(users.createUser(db, { email })).rejects.toBeInstanceOf(UniqueConstraintError);
    await expect(users.findUserByEmail(db, email.toUpperCase())).resolves.not.toBeNull();
  });

  it('stores preferences and working hours relationally', async () => {
    const user = await newUser('prefs');

    await users.upsertUserPreferences(db, user.id, {
      timeZone: LISBON,
      morningNotificationMinute: 480,
    });
    await users.upsertPlanningPreferences(db, user.id, { autonomyLevel: 'AUTOMATICALLY_MANAGE' });
    await users.replaceWorkingHours(db, user.id, [
      { weekday: 'MONDAY', startMinute: 540, endMinute: 780 },
      { weekday: 'MONDAY', startMinute: 840, endMinute: 1080 },
    ]);

    const profile = await users.findPlanningProfile(db, user.id);

    expect(profile?.preferences?.timeZone).toBe(LISBON);
    expect(profile?.preferences?.morningNotificationMinute).toBe(480);
    expect(profile?.planningPreferences?.autonomyLevel).toBe('AUTOMATICALLY_MANAGE');
    expect(profile?.workingHours).toHaveLength(2);
  });

  it('replaces working hours as a set rather than accumulating them', async () => {
    const user = await newUser('hours');
    await users.replaceWorkingHours(db, user.id, [
      { weekday: 'MONDAY', startMinute: 540, endMinute: 1020 },
    ]);
    const second = await users.replaceWorkingHours(db, user.id, [
      { weekday: 'TUESDAY', startMinute: 600, endMinute: 900 },
    ]);

    expect(second).toHaveLength(1);
    expect(second[0]?.weekday).toBe('TUESDAY');
  });

  it('rejects an inverted working-hours block at the database level', async () => {
    const user = await newUser('hours-check');

    // Bypasses the Zod schema on purpose: the CHECK constraint must hold even
    // for a writer that never went through validation.
    await expect(
      db.workingHoursBlock.create({
        data: { userId: user.id, weekday: 'MONDAY', startMinute: 900, endMinute: 600 },
      }),
    ).rejects.toThrow();
  });

  it('erases every owned row when the account is deleted', async () => {
    const user = await newUser('cascade');
    const space = await spaces.getOrCreateSpace(db, user.id, {
      date: '2026-03-30',
      timeZone: LISBON,
    });
    await work.createTask(db, user.id, { title: 'Doomed', spaceId: space.id });
    await audit.appendEvent(db, user.id, {
      eventType: 'TASK_CREATED',
      aggregateType: 'TASK',
      aggregateId: space.id,
    });

    await db.user.delete({ where: { id: user.id } });

    expect(await db.space.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.task.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.eventLog.count({ where: { userId: user.id } })).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Spaces
  // ---------------------------------------------------------------------------

  it('allows exactly one Space per user per calendar date', async () => {
    const user = await newUser('space-unique');

    const first = await spaces.getOrCreateSpace(db, user.id, {
      date: '2026-03-30',
      timeZone: LISBON,
    });
    const second = await spaces.getOrCreateSpace(db, user.id, {
      date: '2026-03-30',
      timeZone: LISBON,
      summary: 'ignored',
    });

    expect(second.id).toBe(first.id);
    expect(await db.space.count({ where: { userId: user.id } })).toBe(1);

    // A direct insert must be rejected by the constraint, not just by the upsert.
    await expect(
      db.space.create({
        data: { userId: user.id, date: toDatabaseDate('2026-03-30'), timeZone: LISBON },
      }),
    ).rejects.toThrow();
  });

  it('lets two users own the same calendar date independently', async () => {
    const [ada, noor] = [await newUser('space-ada'), await newUser('space-noor')];

    await spaces.getOrCreateSpace(db, ada.id, { date: '2026-03-30', timeZone: LISBON });
    await spaces.getOrCreateSpace(db, noor.id, { date: '2026-03-30', timeZone: KOLKATA });

    // Scoped to the two fixture users: the suite must pass against an empty
    // database and against one that already holds seed data.
    const sameDay = await db.space.count({
      where: { date: toDatabaseDate('2026-03-30'), userId: { in: [ada.id, noor.id] } },
    });

    expect(sameDay).toBe(2);
  });

  it('stores the Space date as a calendar date, unaffected by any timezone', async () => {
    const user = await newUser('space-date');
    const created = await spaces.getOrCreateSpace(db, user.id, {
      date: '2026-03-30',
      timeZone: KOLKATA,
    });

    expect(created.date).toBe('2026-03-30');

    const raw = await db.space.findUnique({ where: { id: created.id } });
    // A `date` column round-trips as midnight UTC — never shifted by a day.
    expect(raw?.date.toISOString()).toBe('2026-03-30T00:00:00.000Z');

    const found = await spaces.findSpaceByDate(db, user.id, '2026-03-30');
    expect(found?.date).toBe('2026-03-30');
  });

  it('derives the same instant differently for users in different zones', () => {
    // The same instant is two different calendar days for these two users, which
    // is exactly why the date is stored per user rather than derived globally.
    const instant = new Date('2026-03-29T20:00:00.000Z');

    expect(toCalendarDate(instant, KOLKATA)).toBe('2026-03-30');
    expect(toCalendarDate(instant, 'America/New_York')).toBe('2026-03-29');
  });

  it('lists a bounded range of Spaces and refuses an unbounded one', async () => {
    const user = await newUser('space-range');
    for (const date of ['2026-03-28', '2026-03-29', '2026-03-30', '2026-04-05']) {
      await spaces.getOrCreateSpace(db, user.id, { date, timeZone: LISBON });
    }

    const week = await spaces.listSpacesInRange(db, user.id, '2026-03-28', '2026-03-30');
    expect(week.map((space) => space.date)).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);

    // Rejects rather than throwing synchronously: the guard lives inside an
    // async repository function.
    await expect(
      spaces.listSpacesInRange(db, user.id, '2020-01-01', '2030-01-01'),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('does not let one user change another user’s Space', async () => {
    const [owner, attacker] = [await newUser('owner'), await newUser('attacker')];
    const space = await spaces.getOrCreateSpace(db, owner.id, {
      date: '2026-03-30',
      timeZone: LISBON,
    });

    expect(await spaces.updateSpaceStatus(db, attacker.id, space.id, 'ARCHIVED')).toBe(false);
    expect(await spaces.updateSpaceStatus(db, owner.id, space.id, 'ARCHIVED')).toBe(true);

    const reread = await db.space.findUnique({ where: { id: space.id } });
    expect(reread?.status).toBe('ARCHIVED');
  });

  // ---------------------------------------------------------------------------
  // Space items
  // ---------------------------------------------------------------------------

  it('returns a Space timeline in a deterministic order', async () => {
    const user = await newUser('timeline');
    const space = await spaces.getOrCreateSpace(db, user.id, {
      date: '2026-03-30',
      timeZone: LISBON,
    });

    const first = await work.createTask(db, user.id, { title: 'First', spaceId: space.id });
    const second = await work.createTask(db, user.id, { title: 'Second', spaceId: space.id });
    const reminder = await work.createReminder(db, user.id, {
      title: 'Stand-up',
      remindAt: clock.now(),
      timeZone: LISBON,
      spaceId: space.id,
    });

    await spaces.attachTaskToSpace(db, user.id, second.id, { spaceId: space.id, position: 30 });
    await spaces.attachReminderToSpace(db, user.id, reminder.id, {
      spaceId: space.id,
      position: 20,
    });
    await spaces.attachTaskToSpace(db, user.id, first.id, { spaceId: space.id, position: 10 });

    const timeline = await spaces.getSpaceTimeline(db, user.id, space.id);
    expect(timeline.map((item) => item.kind)).toEqual(['TASK', 'REMINDER', 'TASK']);
    expect(timeline[0]?.task?.title).toBe('First');
    expect(timeline[2]?.task?.title).toBe('Second');

    // Repeating the read must produce the same sequence.
    const again = await spaces.getSpaceTimeline(db, user.id, space.id);
    expect(again.map((item) => item.id)).toEqual(timeline.map((item) => item.id));
  });

  it('moves a task on the timeline instead of duplicating it', async () => {
    const user = await newUser('timeline-move');
    const [monday, tuesday] = [
      await spaces.getOrCreateSpace(db, user.id, { date: '2026-03-30', timeZone: LISBON }),
      await spaces.getOrCreateSpace(db, user.id, { date: '2026-03-31', timeZone: LISBON }),
    ];
    const task = await work.createTask(db, user.id, { title: 'Movable', spaceId: monday.id });

    await spaces.attachTaskToSpace(db, user.id, task.id, { spaceId: monday.id, position: 10 });
    await spaces.attachTaskToSpace(db, user.id, task.id, { spaceId: tuesday.id, position: 10 });

    expect(await db.spaceItem.count({ where: { taskId: task.id } })).toBe(1);
    expect(await db.spaceItem.count({ where: { spaceId: tuesday.id } })).toBe(1);
  });

  it('rejects a Space item that points at nothing or at two things', async () => {
    const user = await newUser('arc');
    const space = await spaces.getOrCreateSpace(db, user.id, {
      date: '2026-03-30',
      timeZone: LISBON,
    });
    const task = await work.createTask(db, user.id, { title: 'Arc', spaceId: space.id });
    const reminder = await work.createReminder(db, user.id, {
      title: 'Arc',
      remindAt: clock.now(),
      timeZone: LISBON,
    });

    await expect(
      db.spaceItem.create({ data: { userId: user.id, spaceId: space.id, kind: 'TASK' } }),
    ).rejects.toThrow();

    await expect(
      db.spaceItem.create({
        data: {
          userId: user.id,
          spaceId: space.id,
          kind: 'TASK',
          taskId: task.id,
          reminderId: reminder.id,
        },
      }),
    ).rejects.toThrow();

    await expect(
      db.spaceItem.create({
        data: { userId: user.id, spaceId: space.id, kind: 'REMINDER', taskId: task.id },
      }),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------

  it('creates a task with every priority the domain defines', async () => {
    const user = await newUser('priority');

    for (const priority of ['CRITICAL', 'HIGH', 'NORMAL', 'LOW'] as const) {
      const task = await work.createTask(db, user.id, { title: priority, priority });
      expect(task.priority).toBe(priority);
    }

    expect(await db.task.count({ where: { userId: user.id } })).toBe(4);
  });

  it('defaults a new task to the inbox with no schedule', async () => {
    const user = await newUser('task-defaults');
    const task = await work.createTask(db, user.id, { title: 'Unplanned' });

    expect(task.status).toBe('INBOX');
    expect(task.priority).toBe('NORMAL');
    expect(task.spaceId).toBeNull();
    expect(task.scheduledStart).toBeNull();
    expect(task.completedAt).toBeNull();
  });

  it('enforces the task status transition table', async () => {
    const user = await newUser('transition');
    const task = await work.createTask(db, user.id, { title: 'Transitions' });

    const planned = await work.changeTaskStatus(db, user.id, task.id, 'PLANNED', clock.now());
    expect(planned?.status).toBe('PLANNED');

    const started = await work.changeTaskStatus(db, user.id, task.id, 'IN_PROGRESS', clock.now());
    expect(started?.status).toBe('IN_PROGRESS');

    const done = await work.changeTaskStatus(db, user.id, task.id, 'COMPLETED', clock.now());
    expect(done?.status).toBe('COMPLETED');
    // `completedAt` is derived from the transition, not supplied by the caller.
    expect(done?.completedAt?.toISOString()).toBe('2026-03-30T09:00:00.000Z');

    await expect(
      work.changeTaskStatus(db, user.id, task.id, 'IN_PROGRESS', clock.now()),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('allows a missed task to be rescheduled and clears the completion time', async () => {
    const user = await newUser('missed');
    const task = await work.createTask(db, user.id, { title: 'Slipped', status: 'PLANNED' });

    await work.changeTaskStatus(db, user.id, task.id, 'MISSED', clock.now());
    const rescheduled = await work.changeTaskStatus(
      db,
      user.id,
      task.id,
      'RESCHEDULED',
      clock.now(),
    );

    expect(rescheduled?.status).toBe('RESCHEDULED');
    expect(rescheduled?.completedAt).toBeNull();
  });

  it('treats a no-op status change as a success', async () => {
    const user = await newUser('noop');
    const task = await work.createTask(db, user.id, { title: 'Same', status: 'PLANNED' });

    await expect(
      work.changeTaskStatus(db, user.id, task.id, 'PLANNED', clock.now()),
    ).resolves.toMatchObject({ status: 'PLANNED' });
  });

  it('reports changed:false and writes nothing when the target status is already current', async () => {
    const user = await newUser('transition-noop');
    const task = await work.createTask(db, user.id, { title: 'Idle', status: 'PLANNED' });

    const outcome = await work.transitionTaskStatus(db, user.id, task.id, 'PLANNED', clock.now(), {
      trigger: 'user',
      reason: 'user-completed-task',
    });

    expect(outcome).toEqual({ taskId: task.id, from: 'PLANNED', to: 'PLANNED', changed: false });
    // No transition event, no agent action: a no-op must not manufacture an
    // audit trail that claims a change happened.
    expect(
      await db.eventLog.count({
        where: { userId: user.id, aggregateId: task.id, eventType: 'TASK_COMPLETED' },
      }),
    ).toBe(0);
    expect(await db.agentAction.count({ where: { entityId: task.id } })).toBe(0);
  });

  it('keeps the audit trail truthful when two transitions race', async () => {
    const user = await newUser('transition-race');
    const task = await work.createTask(db, user.id, { title: 'Racing', status: 'IN_PROGRESS' });

    // Both transitions are legal from IN_PROGRESS. Whichever lands first wins;
    // the loser's compare-and-swap must not overwrite it, must not append a
    // second transition event, and must not record a second agent action. The
    // assertions hold on every interleaving, and each fails without the CAS.
    const [toComplete, toMiss] = await Promise.all([
      work.transitionTaskStatus(db, user.id, task.id, 'COMPLETED', clock.now(), {
        trigger: 'user',
        reason: 'user-completed-task',
      }),
      work.transitionTaskStatus(db, user.id, task.id, 'MISSED', clock.now(), {
        trigger: 'autonomous',
        reason: 'missed:elapsed-scheduled-block',
      }),
    ]);

    const changed = [toComplete, toMiss].filter((outcome) => outcome.changed);
    expect(changed).toHaveLength(1);

    const finalRow = await db.task.findFirst({ where: { id: task.id } });
    expect(finalRow?.status).toBe(changed[0]?.to);

    expect(
      await db.eventLog.count({
        where: { userId: user.id, aggregateId: task.id, eventType: 'TASK_COMPLETED' },
      }),
    ).toBe(changed[0]?.to === 'COMPLETED' ? 1 : 0);
    expect(
      await db.eventLog.count({
        where: { userId: user.id, aggregateId: task.id, eventType: 'TASK_MISSED' },
      }),
    ).toBe(changed[0]?.to === 'MISSED' ? 1 : 0);
    expect(await db.agentAction.count({ where: { entityId: task.id } })).toBe(1);
  });

  it('refuses to touch another user’s task', async () => {
    const [owner, attacker] = [await newUser('task-owner'), await newUser('task-attacker')];
    const task = await work.createTask(db, owner.id, { title: 'Private' });

    await expect(work.findTask(db, attacker.id, task.id)).resolves.toBeNull();
    await expect(
      work.changeTaskStatus(db, attacker.id, task.id, 'COMPLETED', clock.now()),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(
      work.updateTask(db, attacker.id, task.id, { title: 'Hijacked' }),
    ).rejects.toBeInstanceOf(RecordNotFoundError);

    const untouched = await work.findTask(db, owner.id, task.id);
    expect(untouched?.title).toBe('Private');
  });

  it('pages upcoming tasks without repeating a row', async () => {
    const user = await newUser('paging');
    for (let index = 0; index < 5; index += 1) {
      await work.createTask(db, user.id, {
        title: `Task ${index}`,
        status: 'PLANNED',
        dueAt: new Date(Date.UTC(2026, 2, 30, 9 + index)),
      });
    }

    const until = new Date(Date.UTC(2026, 3, 1));
    const first = await work.listUpcomingTasks(db, user.id, { until, page: { limit: 2 } });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await work.listUpcomingTasks(db, user.id, {
      until,
      page: { limit: 2, cursor: first.nextCursor },
    });
    const ids = [...first.items, ...second.items].map((task) => task.id);

    expect(new Set(ids).size).toBe(4);
  });

  it('rejects a negative duration at the database level', async () => {
    const user = await newUser('duration-check');

    await expect(
      db.task.create({ data: { userId: user.id, title: 'Bad', estimatedMinutes: -5 } }),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Reminders
  // ---------------------------------------------------------------------------

  it('persists a reminder with its recurrence rule', async () => {
    const user = await newUser('reminder');
    const reminder = await work.createReminder(db, user.id, {
      title: 'Weekly review',
      remindAt: new Date('2026-04-03T15:00:00.000Z'),
      timeZone: LISBON,
      recurrence: { frequency: 'WEEKLY', interval: 1, byWeekday: ['FRIDAY'] },
    });

    expect(reminder.status).toBe('PENDING');
    expect(reminder.deliveryState).toBe('PENDING');
    expect(reminder.recurrenceFrequency).toBe('WEEKLY');
    expect(reminder.recurrenceByWeekday).toEqual(['FRIDAY']);
    expect(reminder.remindAt.toISOString()).toBe('2026-04-03T15:00:00.000Z');
  });

  it('finds only reminders that are actually due', async () => {
    const user = await newUser('due');
    await work.createReminder(db, user.id, {
      title: 'Past',
      remindAt: new Date('2026-03-30T08:00:00.000Z'),
      timeZone: LISBON,
    });
    await work.createReminder(db, user.id, {
      title: 'Future',
      remindAt: new Date('2026-03-30T10:00:00.000Z'),
      timeZone: LISBON,
    });

    const due = await work.listDueReminders(db, { now: clock.now() });
    const mine = due.filter((row) => row.userId === user.id);

    expect(mine.map((row) => row.title)).toEqual(['Past']);
  });

  it('records a delivery outcome', async () => {
    const user = await newUser('delivered');
    const reminder = await work.createReminder(db, user.id, {
      title: 'Deliver me',
      remindAt: clock.now(),
      timeZone: LISBON,
    });

    const sent = await work.markReminderDelivered(db, reminder.id, { deliveredAt: clock.now() });
    expect(sent.deliveryState).toBe('SENT');
    expect(sent.deliveredAt?.toISOString()).toBe('2026-03-30T09:00:00.000Z');

    const failed = await work.markReminderDelivered(db, reminder.id, {
      deliveredAt: clock.now(),
      failureReason: 'provider rejected',
    });
    expect(failed.deliveryState).toBe('FAILED');
  });

  it('rejects a recurrence that ends twice', async () => {
    const user = await newUser('recurrence-check');

    await expect(
      db.reminder.create({
        data: {
          userId: user.id,
          title: 'Contradictory',
          remindAt: clock.now(),
          timeZone: LISBON,
          recurrenceFrequency: 'WEEKLY',
          recurrenceUntil: new Date('2026-12-31T00:00:00.000Z'),
          recurrenceCount: 10,
        },
      }),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Calendar
  // ---------------------------------------------------------------------------

  it('keeps external events unique per calendar and makes import idempotent', async () => {
    const user = await newUser('calendar');
    const connection = await calendar.upsertCalendarConnection(db, user.id, {
      provider: 'GOOGLE',
      providerAccountId: 'account-1',
    });
    const cal = await calendar.upsertCalendar(db, user.id, {
      connectionId: connection.id,
      externalId: 'primary',
      name: 'Work',
      timeZone: LISBON,
    });

    const payload = {
      calendarId: cal.id,
      externalId: 'event-1',
      title: 'Stand-up',
      startAt: new Date('2026-03-30T08:30:00.000Z'),
      endAt: new Date('2026-03-30T08:45:00.000Z'),
      timeZone: LISBON,
    };

    const first = await calendar.upsertCalendarEvent(db, user.id, payload, {
      syncedAt: clock.now(),
    });
    const second = await calendar.upsertCalendarEvent(
      db,
      user.id,
      { ...payload, title: 'Stand-up (moved)' },
      { syncedAt: clock.now() },
    );

    expect(second.id).toBe(first.id);
    expect(second.title).toBe('Stand-up (moved)');
    expect(await db.calendarEvent.count({ where: { calendarId: cal.id } })).toBe(1);

    await expect(
      db.calendarEvent.create({
        data: {
          userId: user.id,
          calendarId: cal.id,
          provider: 'GOOGLE',
          externalId: 'event-1',
          title: 'Duplicate',
          startAt: payload.startAt,
          endAt: payload.endAt,
          timeZone: LISBON,
        },
      }),
    ).rejects.toThrow();
  });

  it('allows the same provider event id in two different calendars', async () => {
    const user = await newUser('calendar-scope');
    const connection = await calendar.upsertCalendarConnection(db, user.id, {
      provider: 'GOOGLE',
      providerAccountId: 'account-2',
    });
    const [work_, personal] = [
      await calendar.upsertCalendar(db, user.id, {
        connectionId: connection.id,
        externalId: 'work',
        name: 'Work',
        timeZone: LISBON,
      }),
      await calendar.upsertCalendar(db, user.id, {
        connectionId: connection.id,
        externalId: 'personal',
        name: 'Personal',
        timeZone: LISBON,
      }),
    ];

    const base = {
      externalId: 'shared-id',
      title: 'Shared',
      startAt: new Date('2026-03-30T08:30:00.000Z'),
      endAt: new Date('2026-03-30T09:30:00.000Z'),
      timeZone: LISBON,
    };

    await calendar.upsertCalendarEvent(
      db,
      user.id,
      { ...base, calendarId: work_.id },
      {
        syncedAt: clock.now(),
      },
    );
    await calendar.upsertCalendarEvent(
      db,
      user.id,
      { ...base, calendarId: personal.id },
      {
        syncedAt: clock.now(),
      },
    );

    expect(await db.calendarEvent.count({ where: { userId: user.id } })).toBe(2);
  });

  it('persists and updates recurrence linkage on repeated syncs', async () => {
    const user = await newUser('calendar-recurrence');
    const connection = await calendar.upsertCalendarConnection(db, user.id, {
      provider: 'GOOGLE',
      providerAccountId: 'account-4',
    });
    const cal = await calendar.upsertCalendar(db, user.id, {
      connectionId: connection.id,
      externalId: 'primary',
      name: 'Work',
      timeZone: LISBON,
    });

    const payload = {
      calendarId: cal.id,
      externalId: 'abc-20260330T090000Z',
      title: 'Weekly stand-up',
      startAt: new Date('2026-03-30T09:00:00.000Z'),
      endAt: new Date('2026-03-30T09:15:00.000Z'),
      timeZone: LISBON,
      recurringEventId: 'abc-def-123',
      originalStartAt: new Date('2026-03-02T09:00:00.000Z'),
    };

    await calendar.upsertCalendarEvent(db, user.id, payload, { syncedAt: clock.now() });

    const stored = await db.calendarEvent.findUniqueOrThrow({
      where: {
        calendarId_externalId: { calendarId: cal.id, externalId: payload.externalId },
      },
    });
    expect(stored.recurringEventId).toBe('abc-def-123');
    expect(stored.originalStartAt).toEqual(new Date('2026-03-02T09:00:00.000Z'));

    // A moved occurrence updates the recurrence linkage, it does not duplicate.
    const moved = await calendar.upsertCalendarEvent(
      db,
      user.id,
      {
        ...payload,
        title: 'Weekly stand-up (moved)',
        startAt: new Date('2026-03-30T15:00:00.000Z'),
        endAt: new Date('2026-03-30T15:15:00.000Z'),
      },
      { syncedAt: clock.now() },
    );

    expect(moved.id).toBe(stored.id);
    expect(moved.title).toBe('Weekly stand-up (moved)');
    expect(moved.startAt).toEqual(new Date('2026-03-30T15:00:00.000Z'));
    expect(moved.recurringEventId).toBe('abc-def-123');
    expect(await db.calendarEvent.count({ where: { recurringEventId: 'abc-def-123' } })).toBe(1);
  });

  it('selects events by half-open overlap', async () => {
    const user = await newUser('overlap');
    const connection = await calendar.upsertCalendarConnection(db, user.id, {
      provider: 'GOOGLE',
      providerAccountId: 'account-3',
    });
    const cal = await calendar.upsertCalendar(db, user.id, {
      connectionId: connection.id,
      externalId: 'primary',
      name: 'Work',
      timeZone: LISBON,
    });

    await calendar.upsertCalendarEvent(
      db,
      user.id,
      {
        calendarId: cal.id,
        externalId: 'touching',
        title: 'Ends when the window opens',
        startAt: new Date('2026-03-30T08:00:00.000Z'),
        endAt: new Date('2026-03-30T09:00:00.000Z'),
        timeZone: LISBON,
      },
      { syncedAt: clock.now() },
    );
    await calendar.upsertCalendarEvent(
      db,
      user.id,
      {
        calendarId: cal.id,
        externalId: 'overlapping',
        title: 'Straddles the boundary',
        startAt: new Date('2026-03-30T08:30:00.000Z'),
        endAt: new Date('2026-03-30T09:30:00.000Z'),
        timeZone: LISBON,
      },
      { syncedAt: clock.now() },
    );

    const found = await calendar.listCalendarEventsInRange(db, user.id, {
      start: new Date('2026-03-30T09:00:00.000Z'),
      end: new Date('2026-03-30T10:00:00.000Z'),
    });

    expect(found.map((event) => event.externalId)).toEqual(['overlapping']);
  });

  it('hides a soft-deleted event without losing the row', async () => {
    const user = await newUser('soft-delete');
    const connection = await calendar.upsertCalendarConnection(db, user.id, {
      provider: 'GOOGLE',
      providerAccountId: 'account-4',
    });
    const cal = await calendar.upsertCalendar(db, user.id, {
      connectionId: connection.id,
      externalId: 'primary',
      name: 'Work',
      timeZone: LISBON,
    });
    await calendar.upsertCalendarEvent(
      db,
      user.id,
      {
        calendarId: cal.id,
        externalId: 'cancelled',
        title: 'Cancelled upstream',
        startAt: new Date('2026-03-30T08:00:00.000Z'),
        endAt: new Date('2026-03-30T09:00:00.000Z'),
        timeZone: LISBON,
      },
      { syncedAt: clock.now() },
    );

    expect(
      await calendar.softDeleteCalendarEvent(db, user.id, {
        calendarId: cal.id,
        externalId: 'cancelled',
        deletedAt: clock.now(),
      }),
    ).toBe(true);

    const visible = await calendar.listCalendarEventsInRange(db, user.id, {
      start: new Date('2026-03-30T00:00:00.000Z'),
      end: new Date('2026-03-31T00:00:00.000Z'),
    });
    expect(visible).toHaveLength(0);
    expect(await db.calendarEvent.count({ where: { userId: user.id } })).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Notifications and email
  // ---------------------------------------------------------------------------

  it('persists notifications and counts only the unread ones', async () => {
    const user = await newUser('notifications');
    const first = await delivery.createNotification(db, user.id, {
      type: 'DAILY_PLAN',
      title: 'Your day is ready',
      body: 'Three items planned.',
    });
    await delivery.createNotification(db, user.id, {
      type: 'DEADLINE_WARNING',
      priority: 'IMPORTANT',
      title: 'Deadline today',
      body: 'Due at 17:00.',
    });

    expect(await delivery.countUnreadNotifications(db, user.id)).toBe(2);

    expect(await delivery.markNotificationRead(db, user.id, first.id, clock.now())).toBe(true);
    expect(await delivery.countUnreadNotifications(db, user.id)).toBe(1);

    // Marking an already-read notification again preserves the first read time.
    expect(await delivery.markNotificationRead(db, user.id, first.id, clock.now())).toBe(false);

    const unread = await delivery.listNotifications(db, user.id, { unreadOnly: true });
    expect(unread.items).toHaveLength(1);
    expect(unread.items[0]?.priority).toBe('IMPORTANT');
  });

  it('never marks another user’s notification as read', async () => {
    const [owner, attacker] = [await newUser('notif-owner'), await newUser('notif-attacker')];
    const notification = await delivery.createNotification(db, owner.id, {
      type: 'SYSTEM',
      title: 'Private',
      body: 'Private',
    });

    expect(await delivery.markNotificationRead(db, attacker.id, notification.id, clock.now())).toBe(
      false,
    );
    expect(await delivery.countUnreadNotifications(db, owner.id)).toBe(1);
  });

  it('excludes silent notifications from the delivery queue', async () => {
    const user = await newUser('silent');
    await delivery.createNotification(db, user.id, {
      type: 'SYSTEM',
      priority: 'SILENT',
      title: 'Quiet',
      body: 'Recorded only.',
    });

    const due = await delivery.listDueNotifications(db, { now: clock.now() });
    expect(due.filter((row) => row.userId === user.id)).toHaveLength(0);
  });

  it('records an email and applies a provider callback', async () => {
    const user = await newUser('email');
    await delivery.recordEmail(db, {
      userId: user.id,
      recipient: 'Someone@Example.Test',
      template: 'daily-plan',
      provider: 'agentmail',
      providerMessageId: 'msg-1',
    });

    expect(
      await delivery.updateEmailStatus(
        db,
        { provider: 'agentmail', providerMessageId: 'msg-1' },
        { status: 'DELIVERED', sentAt: clock.now() },
      ),
    ).toBe(true);

    const row = await db.emailLog.findFirst({ where: { userId: user.id } });
    expect(row?.status).toBe('DELIVERED');
    expect(row?.recipient).toBe('someone@example.test');
    // The rendered body is never stored.
    expect(Object.keys(row ?? {})).not.toContain('body');
  });

  // ---------------------------------------------------------------------------
  // Audit trail
  // ---------------------------------------------------------------------------

  it('appends events with a monotonic sequence usable as an outbox cursor', async () => {
    const user = await newUser('events');

    for (const eventType of ['SPACE_CREATED', 'TASK_CREATED', 'TASK_COMPLETED'] as const) {
      await audit.appendEvent(db, user.id, {
        eventType,
        aggregateType: 'SPACE',
        aggregateId: 'seedspc00000000000ada002',
        payload: { source: 'integration-test' },
        occurredAt: clock.now(),
        correlationId: 'correlation000000000001',
      });
    }

    const feed = await audit.listUserEvents(db, user.id);
    expect(feed.items).toHaveLength(3);
    expect(feed.items[0]?.payload).toEqual({ source: 'integration-test' });
    expect(feed.items[0]?.correlationId).toBe('correlation000000000001');

    const sequences = feed.items.map((event) => event.sequence);
    expect(new Set(sequences).size).toBe(3);

    const batch = await audit.readEventOutbox(db, { limit: 2 });
    expect(batch.events).toHaveLength(2);
    expect(typeof batch.events[0]?.sequence).toBe('string');
    expect(batch.nextCursor).not.toBeNull();

    const next = await audit.readEventOutbox(db, { afterSequence: batch.nextCursor, limit: 2 });
    const seen = [...batch.events, ...next.events].map((event) => event.id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('appends a batch of events in one statement', async () => {
    const user = await newUser('events-batch');
    await audit.appendEvents(db, user.id, [
      {
        eventType: 'TASK_CREATED',
        aggregateType: 'TASK',
        aggregateId: 'seedtsk00000000000ada001',
        occurredAt: clock.now(),
      },
      {
        eventType: 'TASK_UPDATED',
        aggregateType: 'TASK',
        aggregateId: 'seedtsk00000000000ada001',
        occurredAt: clock.now(),
      },
    ]);

    const history = await audit.listAggregateEvents(db, user.id, {
      aggregateId: 'seedtsk00000000000ada001',
    });
    expect(history.map((event) => event.eventType)).toEqual(['TASK_CREATED', 'TASK_UPDATED']);
  });

  it('records a deterministic engine decision with its factors', async () => {
    const user = await newUser('agent-action');
    const space = await spaces.getOrCreateSpace(db, user.id, {
      date: '2026-03-30',
      timeZone: LISBON,
    });

    await audit.recordAgentAction(db, user.id, {
      actionType: 'TASK_RESCHEDULED',
      spaceId: space.id,
      entityType: 'TASK',
      entityId: 'seedtsk00000000000ada001',
      reason: 'rule:deadline-before-preference',
      factors: { dueInMinutes: 120, remainingFocusMinutes: 45, conflictCount: 1 },
      previousState: { scheduledStart: '2026-03-30T14:00:00.000Z' },
      resultingState: { scheduledStart: '2026-03-30T09:30:00.000Z' },
      correlationId: 'correlation000000000002',
      durationMs: 12,
    });

    const actions = await audit.listAgentActionsForSpace(db, user.id, space.id);
    const action = actions.items[0];

    expect(action?.actionType).toBe('TASK_RESCHEDULED');
    expect(action?.outcome).toBe('SUCCEEDED');
    expect(action?.reason).toBe('rule:deadline-before-preference');
    expect(action?.factors).toEqual({
      dueInMinutes: 120,
      remainingFocusMinutes: 45,
      conflictCount: 1,
    });
    expect(action?.previousState).toEqual({ scheduledStart: '2026-03-30T14:00:00.000Z' });
  });

  it('stores a productivity snapshot once per user and day', async () => {
    const user = await newUser('snapshot');
    const metrics = {
      date: '2026-03-29',
      timeZone: LISBON,
      tasksPlanned: 2,
      tasksCompleted: 1,
      tasksMissed: 1,
      plannedMinutes: 135,
      completedMinutes: 135,
    };

    await audit.upsertProductivitySnapshot(db, user.id, metrics, { computedAt: clock.now() });
    await audit.upsertProductivitySnapshot(
      db,
      user.id,
      { ...metrics, tasksCompleted: 2, tasksMissed: 0 },
      { computedAt: clock.now() },
    );

    const rows = await db.productivitySnapshot.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tasksCompleted).toBe(2);
    expect(rows[0]?.date.toISOString()).toBe('2026-03-29T00:00:00.000Z');
  });
});
