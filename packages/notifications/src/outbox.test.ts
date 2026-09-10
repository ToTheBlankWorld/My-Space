import { createLogger } from '@space/logger';
import { FixedClock } from '@space/time';
import { describe, expect, it } from 'vitest';

import { consumeOutbox, PROCESSOR_NAME } from './outbox';
import { seedSpace, seedUser, updateUserPreferences } from './testing/seed';
import { createFakeDatabase, type FakeDatabaseHandle } from './testing/fake-database';

const USER = 'usr-outbox-0000000000001';
const SPACE = 'spc-outbox-today';
const NOW = '2026-09-10T12:00:00.000Z';

const testLogger = () =>
  createLogger({ name: 'notifications-test', level: 'fatal', destination: { write: () => {} } });

const makeDeps = (handle: FakeDatabaseHandle) => ({
  db: handle.db,
  clock: new FixedClock(NOW),
  logger: testLogger(),
  appUrl: 'https://space.example.com',
});

interface PlanEvent {
  sequence: string;
  payload: Record<string, unknown>;
}

const seedPlanEvents = (handle: FakeDatabaseHandle, events: PlanEvent[]): void => {
  for (const event of events) {
    handle.insert('eventLog', {
      // Ids feed causality (`causationId`) and must satisfy the ≥8-char rule.
      id: `pln-${event.sequence.padStart(7, '0')}`,
      sequence: event.sequence,
      eventType: 'PLANNING_COMPLETED',
      userId: USER,
      aggregateType: 'SPACE',
      aggregateId: SPACE,
      payload: event.payload,
      occurredAt: new Date(NOW),
      correlationId: null,
      causationId: null,
    });
  }
};

const cleanPlan = (planVersion: number, extra: Record<string, unknown> = {}) => ({
  mode: 'applied',
  scheduled: 5,
  unscheduled: 0,
  conflicts: [],
  explanations: [],
  planVersion,
  durationMs: 10,
  ...extra,
});

const baseDb = (handle: FakeDatabaseHandle): FakeDatabaseHandle => {
  seedUser(handle, { id: USER, email: 'user@example.com' });
  seedSpace(handle, { id: SPACE, userId: USER, date: new Date('2026-09-10T00:00:00.000Z') });
  return handle;
};

const emailLogs = (handle: FakeDatabaseHandle) => handle.rows('emailLog');

describe('consumeOutbox', () => {
  it('turns a first PLANNING_COMPLETED into a notification, event, email log and cursor advance', async () => {
    const handle = baseDb(createFakeDatabase());
    seedPlanEvents(handle, [{ sequence: '40', payload: cleanPlan(1) }]);
    const deps = makeDeps(handle);

    const result = await consumeOutbox(deps);

    expect(result.created).toBe(1);
    expect(result.eventsRead).toBe(1);
    expect(result.eventsSkipped).toBe(0);
    expect(result.cursor).toBe('40');

    const notifications = handle.rows('notification');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.deliveryKey).toBe(`plan-change:${SPACE}:1`);
    expect(notifications[0]?.type).toBe('SCHEDULE_CHANGE');
    expect(notifications[0]?.linkUrl).toBe('https://space.example.com/space/2026-09-10');

    expect(emailLogs(handle)).toHaveLength(1);
    expect(emailLogs(handle)[0]?.recipient).toBe('user@example.com');
    expect(emailLogs(handle)[0]?.template).toBe('plan-changed');

    const events = handle.rows('eventLog');
    expect(events.some((event) => event.eventType === 'NOTIFICATION_CREATED')).toBe(true);

    const cursor = await deps.db.outboxCursor.findUnique({
      where: { processorName: PROCESSOR_NAME },
    });
    expect(cursor?.lastSequence?.toString()).toBe('40');
  });

  it('is idempotent: a drained log yields nothing new', async () => {
    const handle = baseDb(createFakeDatabase());
    seedPlanEvents(handle, [{ sequence: '41', payload: cleanPlan(1) }]);
    const deps = makeDeps(handle);

    const first = await consumeOutbox(deps);
    const second = await consumeOutbox(deps);

    expect(first.created).toBe(1);
    expect(second).toMatchObject({ eventsRead: 0, created: 0 });
    expect(handle.rows('notification')).toHaveLength(1);
  });

  it('absorbs a changed replay of the same plan version as a duplicate, not a new notification', async () => {
    const handle = baseDb(createFakeDatabase());
    seedPlanEvents(handle, [
      { sequence: '42', payload: cleanPlan(2) },
      { sequence: '43', payload: cleanPlan(2, { unscheduled: 3 }) },
    ]);
    const deps = makeDeps(handle);

    const result = await consumeOutbox(deps);

    expect(result.drafts).toBe(2);
    expect(result.created).toBe(1);
    expect(handle.rows('notification')).toHaveLength(1);
    expect(handle.rows('notification')[0]?.deliveryKey).toBe(`plan-change:${SPACE}:2`);
  });

  it('only drafts when the plan actually changed against its previous payload', async () => {
    const handle = baseDb(createFakeDatabase());
    seedPlanEvents(handle, [
      { sequence: '44', payload: cleanPlan(3) },
      { sequence: '45', payload: cleanPlan(4, { unscheduled: 2 }) },
    ]);
    const deps = makeDeps(handle);

    // v3 creates; v4's unplaced tasks are a meaningful change → creates.
    const first = await consumeOutbox(deps);
    expect(first.created).toBe(2);

    // v5 replays v4's summary exactly → silent. Nothing new.
    seedPlanEvents(handle, [{ sequence: '46', payload: cleanPlan(5, { unscheduled: 2 }) }]);
    const second = await consumeOutbox(deps);
    expect(second.created).toBe(0);
    expect(handle.rows('notification')).toHaveLength(2);
  });

  it('advances past poison payloads without failing the consumer', async () => {
    const handle = baseDb(createFakeDatabase());
    seedPlanEvents(handle, [
      { sequence: '50', payload: { mode: 'applied' } },
      { sequence: '51', payload: cleanPlan(1) },
    ]);
    const deps = makeDeps(handle);

    const result = await consumeOutbox(deps);

    expect(result.eventsSkipped).toBe(1);
    expect(result.created).toBe(1);
    const cursor = await deps.db.outboxCursor.findUnique({
      where: { processorName: PROCESSOR_NAME },
    });
    expect(cursor?.lastSequence?.toString()).toBe('51');
  });

  it('ignores unrelated event types without touching the cursor', async () => {
    const handle = baseDb(createFakeDatabase());
    handle.insert('eventLog', {
      id: 'evt-000001',
      sequence: '60',
      eventType: 'CALENDAR_SYNCED',
      userId: USER,
      aggregateType: 'CALENDAR_CONNECTION',
      aggregateId: 'conn-1',
      payload: { calendars: 2 },
      occurredAt: new Date(NOW),
      correlationId: null,
      causationId: null,
    });
    const deps = makeDeps(handle);

    const result = await consumeOutbox(deps);

    // The consumer only ever reads what it acts on; cursor untouched.
    expect(result.eventsRead).toBe(0);
    expect(result.eventsSkipped).toBe(0);
    expect(result.created).toBe(0);
    const cursor = await deps.db.outboxCursor.findUnique({
      where: { processorName: PROCESSOR_NAME },
    });
    expect(cursor).toBeNull();
  });

  it('resumes after an unrelated event once a planning event lands later', async () => {
    const handle = baseDb(createFakeDatabase());
    handle.insert('eventLog', {
      id: 'evt-000001',
      sequence: '60',
      eventType: 'CALENDAR_SYNCED',
      userId: USER,
      aggregateType: 'CALENDAR_CONNECTION',
      aggregateId: 'conn-1',
      payload: { calendars: 2 },
      occurredAt: new Date(NOW),
      correlationId: null,
      causationId: null,
    });
    seedPlanEvents(handle, [{ sequence: '61', payload: cleanPlan(1) }]);
    const deps = makeDeps(handle);

    const result = await consumeOutbox(deps);

    expect(result.eventsRead).toBe(1);
    expect(result.created).toBe(1);
  });

  it('stays silent when the user has notifications disabled', async () => {
    const handle = baseDb(createFakeDatabase());
    updateUserPreferences(handle, USER, { notificationsEnabled: false });
    seedPlanEvents(handle, [{ sequence: '70', payload: cleanPlan(1) }]);
    const deps = makeDeps(handle);

    const result = await consumeOutbox(deps);

    expect(result.created).toBe(0);
    expect(result.drafts).toBe(0);
    expect(handle.rows('notification')).toHaveLength(0);
  });

  it('omits the email leg when the user has disabled email notifications', async () => {
    const handle = baseDb(createFakeDatabase());
    updateUserPreferences(handle, USER, { emailNotificationsEnabled: false });
    seedPlanEvents(handle, [{ sequence: '71', payload: cleanPlan(1) }]);
    const deps = makeDeps(handle);

    const result = await consumeOutbox(deps);

    expect(result.created).toBe(1);
    expect(emailLogs(handle)).toHaveLength(0);
  });
});
