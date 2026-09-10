import { createLogger } from '@space/logger';
import { FixedClock } from '@space/time';
import { describe, expect, it, vi } from 'vitest';

import { createNotificationService, type DeliveryServiceDeps } from './service';
import { PROCESSOR_NAME } from './outbox';
import { REMINDER_OCCURRENCE_KEY } from './keys';
import { seedReminder, seedSpace, seedUser } from './testing/seed';
import { createFakeDatabase, type FakeDatabaseHandle } from './testing/fake-database';

const USER = 'usr-sweep-00000000000001';
const SPACE = 'spc-sweep-today';
const NOON = '2026-09-10T12:30:00.000Z';

const testLogger = () =>
  createLogger({ name: 'notifications-test', level: 'fatal', destination: { write: () => {} } });

const makeDeps = (handle: FakeDatabaseHandle): DeliveryServiceDeps => ({
  db: handle.db,
  clock: new FixedClock(NOON),
  logger: testLogger(),
  appUrl: 'https://space.example.com',
  emailProviderConfigured: false,
  enqueueDelivery: vi.fn(() => Promise.resolve()),
  provider: null,
});

const PLAN_VERSION = 4;

const seed = (handle: FakeDatabaseHandle): void => {
  seedUser(handle, {
    id: USER,
    email: 'user@example.com',
    morningNotificationMinute: 420,
    middayNotificationMinute: 720,
  });
  seedSpace(handle, { id: SPACE, userId: USER, date: new Date('2026-09-10T00:00:00.000Z') });
  seedReminder(handle, {
    id: 'rem-000001',
    userId: USER,
    title: 'Standup',
    remindAt: new Date('2026-09-10T09:00:00.000Z'),
  });
  handle.insert('task', {
    id: 'tsk-1',
    userId: USER,
    title: 'Slides',
    status: 'PLANNED',
    scheduledStart: new Date('2026-09-10T10:00:00.000Z'),
    scheduledEnd: new Date('2026-09-10T11:00:00.000Z'),
    scheduledEnded: null,
  });
  handle.insert('eventLog', {
    id: 'evt-00000100',
    sequence: '100',
    eventType: 'PLANNING_COMPLETED',
    userId: USER,
    aggregateType: 'SPACE',
    aggregateId: SPACE,
    payload: {
      mode: 'applied',
      scheduled: 3,
      unscheduled: 1,
      conflicts: [],
      explanations: [],
      planVersion: PLAN_VERSION,
      durationMs: 8,
    },
    occurredAt: new Date(NOON),
    correlationId: null,
    causationId: null,
  });
};

describe('runSweep (end-to-end, provider unconfigured)', () => {
  it('runs all four phases and produces durable, idempotently-keyed artifacts', async () => {
    const handle = createFakeDatabase();
    seed(handle);
    const service = createNotificationService(makeDeps(handle));

    const result = await service.runSweep();

    // 1. Daily cycle: morning + midday fired.
    expect(result.daily.created).toBe(2);
    // 2. Reminder dispatch.
    expect(result.reminders.dispatched).toBe(1);
    // 3. Outbox: plan-change draft created.
    expect(result.outbox.created).toBe(1);
    // 4. Deliveries: every email-enabled notification stays PENDING (no provider).
    expect(result.deliveries.providerUnconfigured).toBe(4); // 2 daily + 1 reminder + 1 plan-change

    const notifications = handle.rows('notification');
    expect(notifications).toHaveLength(4);
    expect(notifications.every((row) => row.deliveryState === 'PENDING')).toBe(true);

    const keys = notifications.map((row) => row.deliveryKey).sort();
    expect(keys).toContain(`daily:morning:${USER}:2026-09-10`);
    expect(keys).toContain(`daily:midday:${USER}:2026-09-10`);
    expect(keys).toContain(REMINDER_OCCURRENCE_KEY('rem-000001', 1));
    expect(keys).toContain(`plan-change:${SPACE}:${PLAN_VERSION}`);

    const emails = handle.rows('emailLog');
    expect(emails).toHaveLength(4);
    expect(emails.every((row) => row.status === 'QUEUED')).toBe(true);

    // Reminder completed; outbox cursor parked after the batch.
    expect(handle.rows('reminder')[0]?.status).toBe('COMPLETED');
    const cursor = await handle.db.outboxCursor.findUnique({
      where: { processorName: PROCESSOR_NAME },
    });
    expect(cursor?.lastSequence?.toString()).toBe('100');

    // Events recorded for each produced artifact.
    const events = handle.rows('eventLog');
    expect(events.filter((event) => event.eventType === 'NOTIFICATION_CREATED')).toHaveLength(4);
    expect(events.some((event) => event.eventType === 'REMINDER_TRIGGERED')).toBe(true);
  });

  it('a second sweep creates nothing new and re-enqueues nothing while provider is off', async () => {
    const handle = createFakeDatabase();
    seed(handle);
    const service = createNotificationService(makeDeps(handle));

    const first = await service.runSweep();
    const second = await service.runSweep();

    expect(first.daily.created).toBe(2);
    expect(second.daily.created).toBe(0);
    expect(second.reminders.dispatched).toBe(0);
    expect(second.outbox.created).toBe(0);
    expect(handle.rows('notification')).toHaveLength(4);
    expect(handle.rows('emailLog')).toHaveLength(4);
  });
});
