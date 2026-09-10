import { createLogger } from '@space/logger';
import { FixedClock } from '@space/time';
import { describe, expect, it, vi } from 'vitest';

import {
  deliverQueuedEmail,
  finalizeFailedDelivery,
  RetryableDeliveryError,
  type DeliveryServiceDeps,
} from './service';
import type { EmailProvider } from './provider';
import { seedUser } from './testing/seed';
import { createFakeDatabase, type FakeDatabaseHandle } from './testing/fake-database';

const USER = 'usr-dlvry-0000000000001';
const NOON = '2026-09-10T12:00:00.000Z';

const testLogger = () =>
  createLogger({ name: 'notifications-test', level: 'fatal', destination: { write: () => {} } });

const makeProvider = (): { provider: EmailProvider; send: ReturnType<typeof vi.fn> } => {
  const send = vi.fn();
  return { provider: { name: 'fake', send }, send };
};

interface SeedInput {
  template?: string;
  notificationState?: string;
}

const seed = (
  handle: FakeDatabaseHandle,
  options: SeedInput = {},
): { notificationId: string; emailLogId: string } => {
  const { template = 'morning-brief', notificationState = 'QUEUED' } = options;
  handle.insert('notification', {
    id: 'ntf-0000009',
    userId: USER,
    type: 'DAILY_PLAN',
    priority: 'NORMAL',
    title: 'Brief',
    body: 'Body',
    deliveryKey: null,
    linkUrl: null,
    readAt: null,
    deliveryState: notificationState,
    scheduledAt: null,
    sentAt: null,
    failureReason: null,
    updatedAt: new Date(NOON),
  });
  handle.insert('emailLog', {
    id: 'log-0000009',
    userId: USER,
    recipient: 'user@example.com',
    template,
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
    notificationId: 'ntf-0000009',
    status: 'QUEUED',
    failureReason: null,
    retryCount: 0,
    sentAt: null,
  });
  return { notificationId: 'ntf-0000009', emailLogId: 'log-0000009' };
};

const makeDeps = (
  handle: FakeDatabaseHandle,
  provider: EmailProvider | null,
): DeliveryServiceDeps => ({
  db: handle.db,
  clock: new FixedClock(NOON),
  logger: testLogger(),
  appUrl: 'https://space.example.com',
  emailProviderConfigured: provider !== null,
  enqueueDelivery: () => Promise.resolve(),
  provider,
});

describe('deliverQueuedEmail', () => {
  it('marks the email sent and the notification SENT with events and an agent action', async () => {
    const handle = createFakeDatabase();
    seedUser(handle, { id: USER, email: 'user@example.com' });
    const { notificationId, emailLogId } = seed(handle);
    const { provider, send } = makeProvider();
    send.mockResolvedValue({ ok: true, providerMessageId: 'm-1' });
    const deps = makeDeps(handle, provider);

    const result = await deliverQueuedEmail(deps, { notificationId, emailLogId });

    expect(result.outcome).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      to: 'user@example.com',
      providerReference: 'ntf-0000009',
    });

    expect(handle.rows('emailLog')[0]).toMatchObject({ status: 'SENT', providerMessageId: 'm-1' });
    expect(handle.rows('notification')[0]?.deliveryState).toBe('SENT');
    expect(handle.rows('eventLog').some((event) => event.eventType === 'NOTIFICATION_SENT')).toBe(
      true,
    );
    const action = handle
      .rows('agentAction')
      .find((row) => row.actionType === 'NOTIFICATION_DISPATCHED');
    expect(action?.outcome).toBe('SUCCEEDED');
  });

  it('throws a retryable error on a transient provider failure and increments the log', async () => {
    const handle = createFakeDatabase();
    seedUser(handle, { id: USER });
    const { notificationId, emailLogId } = seed(handle);
    const { provider, send } = makeProvider();
    send.mockResolvedValue({
      ok: false,
      failure: { kind: 'transient', code: 'http-503', message: 'unavailable' },
    });
    const deps = makeDeps(handle, provider);

    await expect(deliverQueuedEmail(deps, { notificationId, emailLogId })).rejects.toBeInstanceOf(
      RetryableDeliveryError,
    );

    expect(handle.rows('emailLog')[0]).toMatchObject({ status: 'FAILED', retryCount: 1 });
    expect(handle.rows('notification')[0]?.deliveryState).toBe('QUEUED');
  });

  it('dead-letters immediately on a permanent provider failure', async () => {
    const handle = createFakeDatabase();
    seedUser(handle, { id: USER });
    const { notificationId, emailLogId } = seed(handle);
    const { provider, send } = makeProvider();
    send.mockResolvedValue({
      ok: false,
      failure: { kind: 'permanent', code: 'http-400', message: 'bad to address' },
    });
    const deps = makeDeps(handle, provider);

    const result = await deliverQueuedEmail(deps, { notificationId, emailLogId });

    expect(result.outcome).toBe('failed-permanent');
    expect(handle.rows('notification')[0]).toMatchObject({
      deliveryState: 'FAILED',
      failureReason: 'http-400: bad to address',
    });
    expect(handle.rows('eventLog').some((event) => event.eventType === 'NOTIFICATION_FAILED')).toBe(
      true,
    );
  });

  it('never resends when a terminal email already exists (send-then-crash guard)', async () => {
    const handle = createFakeDatabase();
    seedUser(handle, { id: USER });
    const { notificationId, emailLogId } = seed(handle);
    handle.insert('emailLog', {
      id: 'log-0000009-first',
      userId: USER,
      recipient: 'user@example.com',
      template: 'morning-brief',
      provider: 'agentmail',
      providerMessageId: 'm-old',
      data: null,
      notificationId: 'ntf-0000009',
      status: 'SENT',
      failureReason: null,
      retryCount: 0,
      sentAt: new Date(NOON),
    });
    const { provider, send } = makeProvider();
    const deps = makeDeps(handle, provider);

    const result = await deliverQueuedEmail(deps, { notificationId, emailLogId });

    expect(result.outcome).toBe('idempotent-sent');
    expect(send).not.toHaveBeenCalled();
    expect(handle.rows('notification')[0]?.deliveryState).toBe('SENT');
  });

  it('dead-letters a delivery whose template is unknown', async () => {
    const handle = createFakeDatabase();
    seedUser(handle, { id: USER });
    const { notificationId, emailLogId } = seed(handle, { template: 'not-a-template' });
    const { provider, send } = makeProvider();
    const deps = makeDeps(handle, provider);

    const result = await deliverQueuedEmail(deps, { notificationId, emailLogId });

    expect(result.outcome).toBe('failed-permanent');
    expect(send).not.toHaveBeenCalled();
    expect(handle.rows('notification')[0]?.deliveryState).toBe('FAILED');
  });
});

describe('finalizeFailedDelivery', () => {
  it('dead-letters the notification and records a FAILED agent action', async () => {
    const handle = createFakeDatabase();
    seedUser(handle, { id: USER });
    const { notificationId } = seed(handle);
    const deps = makeDeps(handle, null);

    await finalizeFailedDelivery(deps, { notificationId, reason: 'retries exhausted (http-503)' });

    expect(handle.rows('notification')[0]).toMatchObject({
      deliveryState: 'FAILED',
      failureReason: 'retries exhausted (http-503)',
    });
    const action = handle
      .rows('agentAction')
      .find((row) => row.actionType === 'NOTIFICATION_DISPATCHED');
    expect(action?.outcome).toBe('FAILED');
    expect(handle.rows('eventLog').some((event) => event.eventType === 'NOTIFICATION_FAILED')).toBe(
      true,
    );
  });
});
