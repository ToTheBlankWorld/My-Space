import { createLogger } from '@space/logger';
import { FixedClock } from '@space/time';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { prepareDeliveries, reconcileDailyCycles } from './sweep';
import { seedUser } from './testing/seed';
import { createFakeDatabase, type FakeDatabaseHandle } from './testing/fake-database';

const USER = 'usr-daily-00000000000001';
const NOON = '2026-09-10T12:30:00.000Z';
const enqueueNoop = () => Promise.resolve();
const enqueue = vi.fn<(input: { notificationId: string }) => Promise<void>>(enqueueNoop);

const testLogger = () =>
  createLogger({ name: 'notifications-test', level: 'fatal', destination: { write: () => {} } });

const depsFor = (handle: FakeDatabaseHandle, providerConfigured = true) => ({
  db: handle.db,
  clock: new FixedClock(NOON),
  logger: testLogger(),
  appUrl: 'https://space.example.com',
  emailProviderConfigured: providerConfigured,
  enqueueDelivery: enqueue,
});

describe('reconcileDailyCycles', () => {
  it('creates the fired slots of the day, each with an email log, and skips the evening', async () => {
    const handle = createFakeDatabase();
    // morning 07:00, midday 12:00, evening 18:00 — all configured, only the
    // first two have fired by 12:30.
    seedUser(handle, {
      id: USER,
      email: 'user@example.com',
      morningNotificationMinute: 420,
      middayNotificationMinute: 720,
      eveningNotificationMinute: 1080,
    });
    const deps = depsFor(handle);

    const result = await reconcileDailyCycles(deps);

    expect(result.created).toBe(2);

    const notifications = handle.rows('notification');
    expect(notifications).toHaveLength(2);
    expect(notifications.map((row) => row.deliveryKey).sort()).toEqual([
      `daily:midday:${USER}:2026-09-10`,
      `daily:morning:${USER}:2026-09-10`,
    ]);
    expect(handle.rows('emailLog')).toHaveLength(2);
  });

  it('creates nothing when the configured slot has not fired yet', async () => {
    const handle = createFakeDatabase();
    seedUser(handle, {
      id: USER,
      emailNotificationsEnabled: true,
      eveningNotificationMinute: 1080,
    });
    const deps = depsFor(handle);

    const result = await reconcileDailyCycles(deps);

    expect(result.created).toBe(0);
    expect(handle.rows('notification')).toHaveLength(0);
  });

  it('creates nothing when no notification minutes are configured', async () => {
    const handle = createFakeDatabase();
    seedUser(handle, { id: USER });
    const deps = depsFor(handle);

    const result = await reconcileDailyCycles(deps);

    expect(result.created).toBe(0);
  });

  it('creates the in-app notification without an email leg when email is disabled', async () => {
    const handle = createFakeDatabase();
    seedUser(handle, {
      id: USER,
      emailNotificationsEnabled: false,
      morningNotificationMinute: 420,
    });
    const deps = depsFor(handle);

    const result = await reconcileDailyCycles(deps);

    expect(result.created).toBe(1);
    expect(handle.rows('notification')).toHaveLength(1);
    expect(handle.rows('emailLog')).toHaveLength(0);
  });

  it('is idempotent across sweeps', async () => {
    const handle = createFakeDatabase();
    seedUser(handle, { id: USER, morningNotificationMinute: 420 });
    const deps = depsFor(handle);

    const first = await reconcileDailyCycles(deps);
    const second = await reconcileDailyCycles(deps);

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(handle.rows('notification')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// prepareDeliveries
// ---------------------------------------------------------------------------

const seedNotificationWithEmail = (
  handle: FakeDatabaseHandle,
  options: {
    id: string;
    deliveryState?: string;
    scheduledAt?: Date | null;
    emailStatus?: string;
    updatedAt?: Date;
  },
): { notificationId: string; emailLogId: string } => {
  const {
    id,
    deliveryState = 'PENDING',
    scheduledAt = null,
    emailStatus = 'QUEUED',
    updatedAt = new Date(NOON),
  } = options;
  handle.insert('notification', {
    id,
    userId: USER,
    type: 'DAILY_PLAN',
    priority: 'NORMAL',
    title: 'Brief',
    body: 'Body',
    deliveryKey: `daily:morning:${USER}:2026-09-10`,
    linkUrl: 'https://space.example.com/space/2026-09-10',
    readAt: null,
    deliveryState,
    scheduledAt,
    sentAt: null,
    failureReason: null,
    updatedAt,
  });
  const emailLogId = `log-${id}`;
  handle.insert('emailLog', {
    id: emailLogId,
    userId: USER,
    recipient: 'user@example.com',
    template: 'morning-brief',
    provider: 'agentmail',
    providerMessageId: null,
    data: {
      date: '2026-09-10',
      tomorrowDate: '2026-09-11',
      tomorrowPlanned: true,
      openTaskCount: 1,
      scheduledTodayCount: 1,
      completedTodayCount: 0,
      deadlineCount: 0,
      planUrl: 'https://space.example.com/space/2026-09-10',
    },
    notificationId: id,
    status: emailStatus,
    failureReason: null,
    retryCount: 0,
    sentAt: null,
  });
  return { notificationId: id, emailLogId };
};

describe('prepareDeliveries', () => {
  beforeEach(() => enqueue.mockClear());

  it('claims and enqueues a due email notification', async () => {
    const handle = createFakeDatabase();
    seedUser(handle, { id: USER });
    seedNotificationWithEmail(handle, { id: 'ntf-1' });
    const deps = depsFor(handle, true);

    const result = await prepareDeliveries(deps);

    expect(result.prepared).toBe(1);
    expect(handle.rows('notification')[0]?.deliveryState).toBe('QUEUED');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ notificationId: 'ntf-1' });
  });

  it('keeps notifications PENDING when the provider is not configured', async () => {
    const handle = createFakeDatabase();
    seedUser(handle, { id: USER });
    seedNotificationWithEmail(handle, { id: 'ntf-2' });
    const deps = depsFor(handle, false);

    const result = await prepareDeliveries(deps);

    expect(result.providerUnconfigured).toBe(1);
    expect(result.prepared).toBe(0);
    expect(handle.rows('notification')[0]?.deliveryState).toBe('PENDING');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('skips in-app-only notifications that have no email log', async () => {
    const handle = createFakeDatabase();
    seedUser(handle, { id: USER });
    handle.insert('notification', {
      id: 'ntf-3',
      userId: USER,
      type: 'SYSTEM',
      priority: 'NORMAL',
      title: 'No email',
      body: 'In app only',
      deliveryKey: null,
      linkUrl: null,
      readAt: null,
      deliveryState: 'PENDING',
      scheduledAt: null,
      sentAt: null,
      failureReason: null,
      updatedAt: new Date(NOON),
    });
    const deps = depsFor(handle, true);

    const result = await prepareDeliveries(deps);

    expect(result.inAppOnly).toBe(1);
    expect(handle.rows('notification')[0]).toMatchObject({
      deliveryState: 'SKIPPED',
      failureReason: 'in-app-only',
    });
  });

  it('re-enqueues a stale QUEUED row as crash recovery', async () => {
    const handle = createFakeDatabase();
    seedUser(handle, { id: USER });
    seedNotificationWithEmail(handle, {
      id: 'ntf-4',
      deliveryState: 'QUEUED',
      updatedAt: new Date('2026-09-10T02:00:00.000Z'),
    });
    const deps = depsFor(handle, true);

    const result = await prepareDeliveries(deps, { staleQueuedAfterMinutes: 10 });

    expect(result.prepared).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(handle.rows('notification')[0]?.deliveryState).toBe('QUEUED');
  });

  it('treats a terminal email as already delivered and cleans up a stale QUEUED notification', async () => {
    const handle = createFakeDatabase();
    seedUser(handle, { id: USER });
    seedNotificationWithEmail(handle, {
      id: 'ntf-5',
      deliveryState: 'QUEUED',
      updatedAt: new Date('2026-09-10T02:00:00.000Z'),
    });
    Object.assign(handle.rows('emailLog')[0]!, { status: 'SENT', providerMessageId: 'm-1' });
    const deps = depsFor(handle, true);

    const result = await prepareDeliveries(deps);

    expect(result.prepared).toBe(0);
    expect(handle.rows('notification')[0]?.deliveryState).toBe('SENT');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('reverts the claim back to PENDING when enqueueing fails', async () => {
    const handle = createFakeDatabase();
    seedUser(handle, { id: USER });
    seedNotificationWithEmail(handle, { id: 'ntf-6' });
    enqueue.mockRejectedValueOnce(new Error('queue down'));
    const deps = depsFor(handle, true);

    const result = await prepareDeliveries(deps);

    expect(result.reverted).toBe(1);
    expect(handle.rows('notification')[0]?.deliveryState).toBe('PENDING');
  });
});
