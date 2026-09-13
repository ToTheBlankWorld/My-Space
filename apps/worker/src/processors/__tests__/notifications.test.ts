import { vi, describe, expect, it, beforeEach } from 'vitest';

import type { Logger } from '@space/logger';
import { createLogger } from '@space/logger';
import { FixedClock } from '@space/time';

import { processNotificationJob, type NotificationJobDeps } from '../notifications';

/**
 * The shared notification processor, with the notification service mocked.
 * Both runtimes delegate here; these tests pin the sweep plumbing (the
 * provider guard and the enqueueDelivery seam) and delivery error semantics
 * (RetryableDeliveryError rethrown, permanent failures returned).
 */

vi.mock('@space/notifications', () => {
  class RetryableDeliveryError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'RetryableDeliveryError';
      this.code = code;
    }
  }
  return {
    RetryableDeliveryError,
    runSweep: vi.fn(),
    deliverQueuedEmail: vi.fn(),
  };
});

import { RetryableDeliveryError, deliverQueuedEmail, runSweep } from '@space/notifications';

const silentLogger = (): Logger =>
  createLogger({
    name: 'notifications-test',
    level: 'fatal',
    destination: { write: () => undefined },
  });

const makeDeps = (emailProvider: null | Record<string, unknown> = {}) => {
  const enqueueDelivery = vi.fn().mockResolvedValue(undefined);
  const deps: NotificationJobDeps & { enqueueDeliveryMock: ReturnType<typeof vi.fn> } = {
    db: {} as never,
    clock: new FixedClock(new Date('2026-09-13T09:00:00.000Z')),
    logger: silentLogger(),
    appUrl: 'https://space.test',
    emailProvider: emailProvider as never,
    enqueueDelivery,
    enqueueDeliveryMock: enqueueDelivery,
  };
  return deps;
};

beforeEach(() => {
  vi.mocked(runSweep).mockReset();
  vi.mocked(deliverQueuedEmail).mockReset();
});

describe('notification processor — sweep', () => {
  it('runs the sweep and forwards prepared deliveries through the seam', async () => {
    const deps = makeDeps();
    vi.mocked(runSweep).mockImplementation(async (sweepDeps) => {
      await sweepDeps.enqueueDelivery({
        userId: 'user_1',
        notificationId: 'n1',
        emailLogId: 'e1',
        recipient: 'user_1@itest.local',
        template: 'daily-brief',
        data: {},
      });
      return {
        daily: { created: 1 },
        reminders: { attempted: 2, dispatched: 2, duplicates: 0, skipped: 0 },
        outbox: { eventsRead: 3, eventsSkipped: 0, drafts: 1, created: 1, cursor: '9' },
        deliveries: { prepared: 1, inAppOnly: 0, providerUnconfigured: 0, staleWithoutLog: 0, reverted: 0 },
      };
    });

    await processNotificationJob(deps, { kind: 'sweep' });

    expect(runSweep).toHaveBeenCalledTimes(1);
    expect(deps.enqueueDeliveryMock).toHaveBeenCalledWith({ notificationId: 'n1', emailLogId: 'e1' });
  });

  it('never enqueues a delivery job when the provider is unconfigured', async () => {
    const deps = makeDeps(null);
    vi.mocked(runSweep).mockImplementation(async (sweepDeps) => {
      await sweepDeps.enqueueDelivery({
        userId: 'user_1',
        notificationId: 'n1',
        emailLogId: 'e1',
        recipient: 'user_1@itest.local',
        template: 'daily-brief',
        data: {},
      });
      return {
        daily: { created: 0 },
        reminders: { attempted: 0, dispatched: 0, duplicates: 0, skipped: 0 },
        outbox: { eventsRead: 0, eventsSkipped: 0, drafts: 0, created: 0, cursor: null },
        deliveries: { prepared: 0, inAppOnly: 0, providerUnconfigured: 1, staleWithoutLog: 0, reverted: 0 },
      };
    });

    await processNotificationJob(deps, { kind: 'sweep' });

    expect(deps.enqueueDeliveryMock).not.toHaveBeenCalled();
  });
});

describe('notification processor — delivery', () => {
  it('returns the delivery outcome on success', async () => {
    const deps = makeDeps();
    vi.mocked(deliverQueuedEmail).mockResolvedValue({ outcome: 'sent' });

    const result = await processNotificationJob(deps, {
      kind: 'delivery',
      notificationId: 'n1',
      emailLogId: 'e1',
    });

    expect(result).toEqual({ outcome: 'sent' });
    expect(deliverQueuedEmail).toHaveBeenCalledWith(
      expect.anything(),
      { notificationId: 'n1', emailLogId: 'e1' },
    );
  });

  it('rethrows RetryableDeliveryError so the owning queue retries with backoff', async () => {
    const deps = makeDeps();
    vi.mocked(deliverQueuedEmail).mockRejectedValue(new RetryableDeliveryError('timeout', 'provider timed out'));

    await expect(
      processNotificationJob(deps, { kind: 'delivery', notificationId: 'n1', emailLogId: 'e1' }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('propagates permanent failure outcomes recorded by the service', async () => {
    const deps = makeDeps();
    vi.mocked(deliverQueuedEmail).mockResolvedValue({ outcome: 'failed-permanent' });

    const result = await processNotificationJob(deps, {
      kind: 'delivery',
      notificationId: 'n1',
      emailLogId: 'e1',
    });

    expect(result).toEqual({ outcome: 'failed-permanent' });
  });
});
