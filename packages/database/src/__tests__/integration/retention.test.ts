import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import type { DatabaseClient } from '../../client';
import * as audit from '../../repositories/audit';
import * as calendar from '../../repositories/calendar';
import * as delivery from '../../repositories/delivery';
import * as retention from '../../repositories/retention';
import * as spaces from '../../repositories/spaces';
import * as users from '../../repositories/users';
import { cleanupTestData, createTestClient, describeIntegration, testEmail } from './setup';

/**
 * Retention behaviour only a real database can prove: age-based prunes must
 * spare in-flight and referenced rows, and the event log must never be pruned
 * below the smallest consumed outbox cursor.
 */

const LISBON = 'Europe/Lisbon';

/** Old enough that any 90-day window would prune it. */
const OLD = new Date('2026-01-15T00:00:00.000Z');
/** A sane prune cut-off: after `OLD`, before `RECENT`. */
const CUTOFF = new Date('2026-02-15T00:00:00.000Z');
/** New enough that no conservative window would prune it. */
const RECENT = new Date('2026-02-20T00:00:00.000Z');

describeIntegration('retention', () => {
  let db: DatabaseClient;

  const newUser = async (label: string) =>
    users.createUser(db, { email: testEmail(label), name: 'Test Person' });

  const appendOldEvent = async (userId: string, label: string) =>
    audit.appendEvent(db, userId, {
      eventType: 'TASK_CREATED',
      aggregateType: 'TASK',
      aggregateId: `aggregate-${label}`,
      occurredAt: OLD,
    });

  const cal = async (
    userId: string,
    { account, externalId }: { account: string; externalId: string },
  ) => {
    const connection = await calendar.upsertCalendarConnection(db, userId, {
      provider: 'GOOGLE',
      providerAccountId: account,
    });
    return calendar.upsertCalendar(db, userId, {
      connectionId: connection.id,
      externalId,
      name: 'Work',
      timeZone: LISBON,
    });
  };

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

  it('never prunes the event log while no consumer has committed a cursor', async () => {
    const user = await newUser('retention-no-cursor');
    await appendOldEvent(user.id, 'a');
    await appendOldEvent(user.id, 'b');

    const result = await retention.pruneEventLogs(db, CUTOFF);

    expect(result).toEqual({ deleted: 0, skipped: true });
    expect(await db.eventLog.count({ where: { userId: user.id } })).toBe(2);
  });

  it('prunes old event log rows only below the smallest consumed cursor', async () => {
    const user = await newUser('retention-cursor');
    const first = await appendOldEvent(user.id, 'a');
    const second = await appendOldEvent(user.id, 'b');
    const third = await appendOldEvent(user.id, 'c');

    // Two consumers: one has committed through `first`, the other only through
    // `second`. The oldest committed boundary is `second`.
    await db.outboxCursor.createMany({
      data: [
        { processorName: 'consumer-a', lastSequence: first.sequence },
        { processorName: 'consumer-b', lastSequence: second.sequence },
      ],
    });

    const result = await retention.pruneEventLogs(db, CUTOFF);

    // `first` and `second` sit at or below the minimum committed sequence and
    // are older than the cut-off; `third` is still beyond every cursor.
    expect(result).toMatchObject({ deleted: 2, skipped: false });
    expect(await db.eventLog.count({ where: { userId: user.id } })).toBe(1);
    expect((await db.eventLog.findMany({ where: { userId: user.id } }))[0]?.id).toBe(third.id);
  });

  it('never prunes recent event log rows, even below the cursor', async () => {
    const user = await newUser('retention-recent-log');
    const recent = await audit.appendEvent(db, user.id, {
      eventType: 'TASK_CREATED',
      aggregateType: 'TASK',
      aggregateId: 'aggregate-recent',
      occurredAt: RECENT,
    });
    await db.outboxCursor.create({
      data: { processorName: 'consumer-c', lastSequence: recent.sequence },
    });

    const result = await retention.pruneEventLogs(db, CUTOFF);

    expect(result).toMatchObject({ deleted: 0, skipped: false });
    expect(await db.eventLog.count({ where: { userId: user.id } })).toBe(1);
  });

  it('prunes old agent actions by age', async () => {
    const user = await newUser('retention-actions');
    await db.agentAction.create({
      data: {
        userId: user.id,
        actionType: 'TASK_SCHEDULED',
        reason: 'rule:fit-earliest',
        occurredAt: OLD,
      },
    });
    await db.agentAction.create({
      data: {
        userId: user.id,
        actionType: 'WORKLOAD_BALANCED',
        reason: 'rule:balance',
        occurredAt: RECENT,
      },
    });

    const result = await retention.pruneAgentActions(db, CUTOFF);

    expect(result).toMatchObject({ deleted: 1, skipped: false });
    expect(await db.agentAction.count({ where: { userId: user.id } })).toBe(1);
  });

  it('prunes notifications only when delivery reached a terminal state', async () => {
    const user = await newUser('retention-notifications');
    const sent = await delivery.createNotification(db, user.id, {
      type: 'DAILY_PLAN',
      title: 'Sent',
      body: 'Delivered long ago',
    });
    await delivery.createNotification(db, user.id, {
      type: 'SYSTEM',
      title: 'Queued',
      body: 'Still pending',
    });

    await db.notification.update({
      where: { id: sent.id },
      data: { deliveryState: 'SENT', createdAt: OLD },
    });

    const result = await retention.pruneNotifications(db, CUTOFF);

    expect(result).toMatchObject({ deleted: 1, skipped: false });
    expect(await db.notification.count({ where: { userId: user.id } })).toBe(1);
  });

  it('prunes email logs only after a terminal provider status', async () => {
    const user = await newUser('retention-emails');
    await delivery.recordEmail(db, {
      userId: user.id,
      recipient: 'done@example.test',
      template: 'daily-plan',
      provider: 'agentmail',
      providerMessageId: 'msg-done',
    });
    await delivery.recordEmail(db, {
      userId: user.id,
      recipient: 'pending@example.test',
      template: 'daily-plan',
      provider: 'agentmail',
      providerMessageId: 'msg-pending',
    });

    const done = await db.emailLog.findFirstOrThrow({
      where: { providerMessageId: 'msg-done' },
    });
    await delivery.updateEmailStatus(
      db,
      { provider: 'agentmail', providerMessageId: 'msg-done' },
      { status: 'DELIVERED', sentAt: OLD },
    );
    await db.emailLog.update({
      where: { id: done.id },
      data: { createdAt: OLD },
    });

    const result = await retention.pruneEmailLogs(db, CUTOFF);

    expect(result).toMatchObject({ deleted: 1, skipped: false });
    expect(await db.emailLog.count({ where: { userId: user.id } })).toBe(1);
  });

  it('prunes expired sessions and verifications by their expiry', async () => {
    const user = await newUser('retention-sessions');
    await db.verification.create({
      data: { identifier: 'state-old', value: 'x', expiresAt: OLD },
    });

    await db.session.create({
      data: {
        userId: user.id,
        token: 'session-fresh',
        expiresAt: new Date(RECENT.getTime() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    expect(await retention.pruneExpiredSessions(db, CUTOFF)).toMatchObject({ deleted: 1 });
    expect(await retention.pruneExpiredVerifications(db, CUTOFF)).toMatchObject({ deleted: 1 });

    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.verification.count({ where: { value: 'x' } })).toBe(0);
  });

  it('prunes unreferenced event tombstones but keeps referenced ones', async () => {
    const user = await newUser('retention-tombstones');
    const primary = await cal(user.id, { account: 'account-ret', externalId: 'primary' });

    await calendar.upsertCalendarEvent(
      db,
      user.id,
      {
        calendarId: primary.id,
        externalId: 'orphaned',
        title: 'Deleted upstream',
        startAt: OLD,
        endAt: OLD,
        timeZone: LISBON,
      },
      { syncedAt: OLD },
    );
    const referenced = await calendar.upsertCalendarEvent(
      db,
      user.id,
      {
        calendarId: primary.id,
        externalId: 'referenced',
        title: 'Still cited',
        startAt: OLD,
        endAt: OLD,
        timeZone: LISBON,
      },
      { syncedAt: OLD },
    );

    await calendar.softDeleteCalendarEvent(db, user.id, {
      calendarId: primary.id,
      externalId: 'orphaned',
      deletedAt: OLD,
    });
    await calendar.softDeleteCalendarEvent(db, user.id, {
      calendarId: primary.id,
      externalId: 'referenced',
      deletedAt: OLD,
    });

    // Cite the referenced tombstone from a plan. Pruning must not cascade it
    // out of the user's day.
    const space = await spaces.getOrCreateSpace(db, user.id, {
      date: '2026-01-20',
      timeZone: LISBON,
    });
    await db.spaceItem.create({
      data: {
        spaceId: space.id,
        userId: user.id,
        kind: 'CALENDAR_EVENT',
        calendarEventId: referenced.id,
        position: 0,
        scheduledStart: OLD,
        scheduledEnd: OLD,
      },
    });

    const result = await retention.pruneCalendarEventTombstones(db, CUTOFF);

    expect(result).toMatchObject({ deleted: 1, skipped: false });
    expect(await db.calendarEvent.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.spaceItem.count({ where: { userId: user.id } })).toBe(1);
  });
});
