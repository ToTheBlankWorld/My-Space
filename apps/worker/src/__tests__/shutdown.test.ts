import { createLogger, type Logger } from '@space/logger';
import { describe, expect, it, vi } from 'vitest';

import { ShutdownController } from '../lifecycle/shutdown';

const silentLogger = (): Logger =>
  createLogger({ name: 'test-worker', level: 'fatal', destination: { write: () => undefined } });

describe('ShutdownController', () => {
  it('releases resources in reverse registration order', async () => {
    const released: string[] = [];
    const controller = new ShutdownController({ logger: silentLogger(), timeoutMs: 1_000 });

    controller.register({ name: 'first', dispose: () => void released.push('first') });
    controller.register({ name: 'second', dispose: () => void released.push('second') });
    controller.register({ name: 'third', dispose: () => void released.push('third') });

    await controller.shutdown('test');

    expect(released).toEqual(['third', 'second', 'first']);
  });

  it('runs teardown once even when shutdown is requested repeatedly', async () => {
    const dispose = vi.fn();
    const controller = new ShutdownController({ logger: silentLogger(), timeoutMs: 1_000 });
    controller.register({ name: 'resource', dispose });

    await Promise.all([
      controller.shutdown('SIGTERM'),
      controller.shutdown('SIGINT'),
      controller.shutdown('SIGTERM'),
    ]);

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('continues after a task throws, so one bad resource cannot strand the rest', async () => {
    const dispose = vi.fn();
    const controller = new ShutdownController({ logger: silentLogger(), timeoutMs: 1_000 });

    controller.register({ name: 'healthy', dispose });
    controller.register({
      name: 'broken',
      dispose: () => Promise.reject(new Error('connection already closed')),
    });

    await expect(controller.shutdown('test')).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('gives up when teardown exceeds the timeout budget', async () => {
    vi.useFakeTimers();
    const controller = new ShutdownController({ logger: silentLogger(), timeoutMs: 50 });
    controller.register({ name: 'stuck', dispose: () => new Promise<void>(() => undefined) });

    const pending = controller.shutdown('test');
    await vi.advanceTimersByTimeAsync(60);

    await expect(pending).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('reports that it is shutting down and refuses new registrations', async () => {
    const controller = new ShutdownController({ logger: silentLogger(), timeoutMs: 1_000 });

    expect(controller.isShuttingDown).toBe(false);
    const pending = controller.shutdown('test');
    expect(controller.isShuttingDown).toBe(true);
    expect(() => controller.register({ name: 'late', dispose: () => undefined })).toThrow(
      /Cannot register "late"/,
    );

    await pending;
  });
});
