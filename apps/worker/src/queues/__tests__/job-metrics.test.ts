import { createMetrics } from '@space/metrics';
import { QUEUE_NAMES } from '@space/types';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';

import { attachJobMetrics, createJobMetrics, type JobMetrics } from '..';

/**
 * Real BullMQ workers pointed at an unreachable port, mirroring the queue
 * naming suite: this exercises the constructor and listener contract without a
 * Redis server. Every connection attempt is refused instantly and errors are
 * swallowed with a noop listener.
 */
const deadConnectionOptions = {
  host: '127.0.0.1',
  port: 1,
  connectTimeout: 100,
  retryStrategy: () => null,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
} as unknown as Redis;

const noopErrorListener = () => undefined;

/** No-op processor returning a settled promise (AsyncProcessor contract). */
const noopProcessor = (): Promise<void> => Promise.resolve();

/** A minimal Worker double that records the handlers attachJobMetrics wires up. */
const captureWorker = (): { worker: Worker; handlers: Map<string, (...args: unknown[]) => void> } => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const worker = {
    on: (event: string, handler: (...args: unknown[]) => void): Worker => {
      handlers.set(event, handler);
      return worker as unknown as Worker;
    },
  };
  return { worker: worker as unknown as Worker, handlers };
};

describe('shared worker job metrics', () => {
  const disposables: Worker[] = [];

  afterEach(async () => {
    for (const disposable of disposables.reverse()) {
      await disposable.close();
    }
    disposables.length = 0;
  });

  it('registers the four job metric families exactly once', () => {
    const metrics = createMetrics();
    const jobMetrics = createJobMetrics(metrics);

    const snapshot = metrics.snapshot();
    expect(snapshot).toEqual({
      worker_jobs_started_total: 0,
      worker_jobs_completed_total: 0,
      worker_jobs_failed_total: 0,
      worker_job_duration_seconds: 0,
    });

    const exposition = metrics.render();
    for (const metric of Object.keys(snapshot)) {
      expect(exposition).toContain(`# HELP ${metric}`);
      expect(exposition).toContain(`# TYPE ${metric}`);
    }
    expect(jobMetrics).toHaveProperty('started');
    expect(jobMetrics).toHaveProperty('completed');
    expect(jobMetrics).toHaveProperty('failed');
    expect(jobMetrics).toHaveProperty('duration');
  });

  it('attaching many workers through the same JobMetrics never re-registers', () => {
    const metrics = createMetrics();
    const jobMetrics = createJobMetrics(metrics);

    const names = ['space:calendar-sync', 'space:maintenance', 'space:planning'];
    for (const queueName of names) {
      const { worker } = captureWorker();
      expect(() => attachJobMetrics(worker, jobMetrics, queueName)).not.toThrow();
    }

    // Still exactly the four original families — no duplicates, no extras.
    expect(Object.keys(metrics.snapshot())).toEqual([
      'worker_jobs_started_total',
      'worker_jobs_completed_total',
      'worker_jobs_failed_total',
      'worker_job_duration_seconds',
    ]);
  });

  it('shares one JobMetrics across all five production workers', () => {
    const metrics = createMetrics();
    const jobMetrics = createJobMetrics(metrics);

    const workerByQueue: Array<[string, Worker]> = [
      [QUEUE_NAMES.calendarSync, new Worker(QUEUE_NAMES.calendarSync, noopProcessor, { connection: deadConnectionOptions })],
      [QUEUE_NAMES.maintenance, new Worker(QUEUE_NAMES.maintenance, noopProcessor, { connection: deadConnectionOptions })],
      [QUEUE_NAMES.planning, new Worker(QUEUE_NAMES.planning, noopProcessor, { connection: deadConnectionOptions })],
      [QUEUE_NAMES.notifications, new Worker(QUEUE_NAMES.notifications, noopProcessor, { connection: deadConnectionOptions })],
      [QUEUE_NAMES.autonomyReview, new Worker(QUEUE_NAMES.autonomyReview, noopProcessor, { connection: deadConnectionOptions })],
    ];

    for (const [queueName, worker] of workerByQueue) {
      worker.on('error', noopErrorListener);
      disposables.push(worker);
      expect(() => attachJobMetrics(worker, jobMetrics, `space:${queueName}`)).not.toThrow();
    }

    expect(Object.keys(metrics.snapshot())).toHaveLength(4);
  });

  it('keeps per-queue and per-job-name labels on the shared families', () => {
    const metrics = createMetrics();
    const jobMetrics: JobMetrics = createJobMetrics(metrics);

    const calendar = captureWorker();
    const planning = captureWorker();
    const maintenance = captureWorker();

    attachJobMetrics(calendar.worker, jobMetrics, 'space:calendar-sync');
    attachJobMetrics(planning.worker, jobMetrics, 'space:planning');
    attachJobMetrics(maintenance.worker, jobMetrics, 'space:maintenance');

    calendar.handlers.get('active')?.({ name: 'sync' });
    planning.handlers.get('active')?.({ name: 'too-many' });
    planning.handlers.get('active')?.({ name: 'plan' });
    calendar.handlers.get('completed')?.({ finishedOn: 710, processedOn: 700, name: 'sync' });
    maintenance.handlers.get('failed')?.({ name: 'prune-retained-data' });
    maintenance.handlers.get('failed')?.({ finishedOn: 810, processedOn: 800, name: 'prune-retained-data' });

    const exposition = metrics.render();

    expect(exposition).toContain(
      'worker_jobs_started_total{jobName="sync",queue="space:calendar-sync"} 1',
    );
    expect(exposition).toContain('worker_jobs_started_total{jobName="plan",queue="space:planning"} 1');
    expect(exposition).toContain('worker_jobs_completed_total{queue="space:calendar-sync"} 1');
    expect(exposition).toContain('worker_jobs_failed_total{queue="space:maintenance"} 2');
    expect(exposition).toContain('worker_job_duration_seconds_count{queue="space:calendar-sync"} 1');
    expect(exposition).toContain('worker_job_duration_seconds_sum{queue="space:calendar-sync"} 0.01');
  });

  it('the registry still rejects a genuinely duplicate registration', () => {
    const metrics = createMetrics();
    createJobMetrics(metrics);

    expect(() => createJobMetrics(metrics)).toThrow(/already registered/);
  });
});