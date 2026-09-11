import { QUEUE_NAMES, QUEUE_PREFIX } from '@space/types';
import { createLogger, type Logger } from '@space/logger';
import { Queue, type Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';

import { createQueues } from '..';
import { createAutonomyReviewWorker } from '../autonomy-review-worker';
import { createCalendarSyncWorker } from '../calendar-sync-worker';
import { createMaintenanceWorker } from '../maintenance-worker';
import { createNotificationWorker } from '../notification-worker';
import { createPlanningWorker } from '../planning-worker';

/**
 * Real BullMQ + real ioredis, but pointed at an unreachable port.
 *
 * These tests exercise the constructor-time contract (name, prefix, qualified
 * name) — including BullMQ's own queue-name validation — without a Redis
 * server. The connection options resolve to `127.0.0.1:1`, which every
 * connection attempt will refuse instantly, and BullMQ surfaces the resulting
 * errors on the queue/worker as `error` events (handled with a noop listener).
 */
const deadConnectionOptions = {
  host: '127.0.0.1',
  port: 1,
  connectTimeout: 100,
  retryStrategy: () => null,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
} as unknown as Redis;

const silentLogger = (): Logger =>
  createLogger({
    name: 'queue-naming-test',
    level: 'fatal',
    destination: { write: () => undefined },
  });

const stubDb = {} as never;
const stubClock = { now: () => new Date() } as never;
const retentionConfig = {
  eventLogDays: 1,
  agentActionDays: 1,
  notificationDays: 1,
  emailLogDays: 1,
  sessionDays: 1,
  verificationDays: 1,
  calendarEventTombstoneDays: 1,
};

const noopErrorListener = () => undefined;

describe('queue naming (BullMQ 5.81+ prefix namespace)', () => {
  const disposables: Array<Queue | Worker> = [];

  afterEach(async () => {
    // Reverse order: close workers before the queues they consume from.
    for (const disposable of disposables.reverse()) {
      await disposable.close();
    }
    disposables.length = 0;
  });

  it('uses a single, colon-free namespace prefix', () => {
    expect(QUEUE_PREFIX).toBe('space');
    expect(QUEUE_PREFIX).not.toMatch(/:/);
  });

  it.each(Object.entries(QUEUE_NAMES))('%s resolves to a colon-free name', (_key, name) => {
    expect(name).not.toMatch(/:/);
  });

  it('names all five production queues and the refresh queue without colons', () => {
    expect(Object.values(QUEUE_NAMES)).toEqual([
      'calendar-sync',
      'calendar-refresh',
      'maintenance',
      'planning',
      'notifications',
      'autonomy-review',
    ]);
  });

  it.each(Object.entries(QUEUE_NAMES))(
    'constructs queue %s with name "%s" and prefix "space" without throwing',
    (_key, name) => {
      const queue = new Queue(name, { connection: deadConnectionOptions, prefix: QUEUE_PREFIX });
      queue.on('error', noopErrorListener);
      disposables.push(queue);

      expect(queue.name).toBe(name);
      expect(queue.opts.prefix).toBe('space');
      expect(queue.qualifiedName).toBe(`space:${name}`);
    },
  );

  it('rejects the legacy colon-containing queue-name form', () => {
    expect(
      () => new Queue('space:calendar-sync', { connection: deadConnectionOptions, prefix: 'bull' }),
    ).toThrow(/Queue name cannot contain :/);
  });

  it('builds every queue definition on the shared prefix namespace', () => {
    const queues = createQueues(deadConnectionOptions);
    (Object.values(queues) as Queue[]).forEach((queue) => {
      queue.on('error', noopErrorListener);
      disposables.push(queue);
    });

    const names = {
      calendarSync: 'space:calendar-sync',
      calendarRefresh: 'space:calendar-refresh',
      maintenance: 'space:maintenance',
      planning: 'space:planning',
      notifications: 'space:notifications',
      autonomyReview: 'space:autonomy-review',
    };

    for (const [key, qualifiedName] of Object.entries(names)) {
      const queue = queues[key as keyof typeof queues];
      expect(queue.name).toBe(QUEUE_NAMES[key as keyof typeof QUEUE_NAMES]);
      expect(queue.opts.prefix).toBe('space');
      expect(queue.qualifiedName).toBe(qualifiedName);
    }
  });

  it('starts every worker factory on the same queue the producer uses', () => {
    const connection = deadConnectionOptions;
    const queues = createQueues(connection);
    (Object.values(queues) as Queue[]).forEach((queue) => {
      queue.on('error', noopErrorListener);
      disposables.push(queue);
    });

    const calendarSyncWorker = createCalendarSyncWorker({
      logger: silentLogger(),
      connection,
      db: stubDb,
      clock: stubClock,
      keyring: {} as never,
      google: {} as never,
    });
    const maintenanceWorker = createMaintenanceWorker({
      logger: silentLogger(),
      connection,
      db: stubDb,
      clock: stubClock,
      retention: retentionConfig,
    });
    const planningWorker = createPlanningWorker({
      logger: silentLogger(),
      connection,
      db: stubDb,
      clock: stubClock,
    });
    const notificationWorker = createNotificationWorker({
      logger: silentLogger(),
      connection,
      db: stubDb,
      clock: stubClock,
      appUrl: 'http://localhost:3000',
      emailProvider: null,
      queues,
    });
    const autonomyWorker = createAutonomyReviewWorker({
      logger: silentLogger(),
      connection,
      db: stubDb,
      clock: stubClock,
      queues,
      appUrl: 'http://localhost:3000',
    });

    const workers: Array<[string, Worker]> = [
      ['space:calendar-sync', calendarSyncWorker],
      ['space:maintenance', maintenanceWorker],
      ['space:planning', planningWorker],
      ['space:notifications', notificationWorker],
      ['space:autonomy-review', autonomyWorker],
    ];

    for (const [qualifiedName, worker] of workers) {
      worker.on('error', noopErrorListener);
      disposables.push(worker);
      expect(worker.opts.prefix).toBe('space');
      expect(worker.qualifiedName).toBe(qualifiedName);
    }
  });
});
