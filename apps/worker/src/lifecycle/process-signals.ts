import type { Logger } from '@space/logger';

import type { ShutdownController } from './shutdown';

/** Signals a container platform uses to ask a process to stop. */
const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export interface ProcessSignalOptions {
  controller: ShutdownController;
  logger: Logger;
  /** Injected for tests; defaults to ending the process. */
  exit?: (code: number) => void;
}

/**
 * Wires process-level termination and crash handling to the shutdown controller.
 *
 * An unhandled rejection or an uncaught exception leaves the process in an
 * unknown state, so both are treated as fatal: the process releases what it can
 * and exits non-zero, letting the platform restart it cleanly.
 *
 * @returns A function that removes every listener this call installed.
 */
export const installProcessSignalHandlers = ({
  controller,
  logger,
  exit = (code) => process.exit(code),
}: ProcessSignalOptions): (() => void) => {
  const stopWith = (reason: string, code: number): void => {
    void controller.shutdown(reason).then(() => {
      exit(code);
    });
  };

  const signalHandlers = TERMINATION_SIGNALS.map((signal) => {
    const handler = (): void => {
      logger.info({ signal }, 'termination signal received');
      stopWith(signal, 0);
    };

    process.on(signal, handler);
    return [signal, handler] as const;
  });

  const onUnhandledRejection = (reason: unknown): void => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    stopWith('unhandledRejection', 1);
  };

  const onUncaughtException = (error: Error): void => {
    logger.fatal({ err: error }, 'uncaught exception');
    stopWith('uncaughtException', 1);
  };

  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);

  return () => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    process.off('unhandledRejection', onUnhandledRejection);
    process.off('uncaughtException', onUncaughtException);
  };
};
