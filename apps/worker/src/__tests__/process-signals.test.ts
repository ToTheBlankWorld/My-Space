import { createLogger, type Logger } from '@space/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installProcessSignalHandlers } from '../lifecycle/process-signals';
import { ShutdownController } from '../lifecycle/shutdown';

const silentLogger = (): Logger =>
  createLogger({ name: 'test-worker', level: 'fatal', destination: { write: () => undefined } });

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

describe('installProcessSignalHandlers', () => {
  it('drains the controller and exits zero on SIGTERM', async () => {
    const dispose = vi.fn();
    const exit = vi.fn();
    const controller = new ShutdownController({ logger: silentLogger(), timeoutMs: 1_000 });
    controller.register({ name: 'resource', dispose });

    uninstall = installProcessSignalHandlers({ controller, logger: silentLogger(), exit });

    process.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('treats an unhandled rejection as fatal and exits non-zero', async () => {
    const exit = vi.fn();
    const controller = new ShutdownController({ logger: silentLogger(), timeoutMs: 1_000 });

    uninstall = installProcessSignalHandlers({ controller, logger: silentLogger(), exit });

    process.emit('unhandledRejection', new Error('boom'), Promise.resolve());
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('removes every listener it installed', () => {
    const controller = new ShutdownController({ logger: silentLogger(), timeoutMs: 1_000 });
    const before = process.listenerCount('SIGTERM');

    const remove = installProcessSignalHandlers({
      controller,
      logger: silentLogger(),
      exit: () => undefined,
    });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);

    remove();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
