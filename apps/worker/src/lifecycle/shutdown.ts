import type { Logger } from '@space/logger';

/** A resource that must be released before the process exits. */
export interface ShutdownTask {
  /** Stable identifier used in logs, e.g. `'health-server'`. */
  readonly name: string;
  readonly dispose: () => Promise<void> | void;
}

export interface ShutdownControllerOptions {
  logger: Logger;
  /** Milliseconds allowed for all tasks combined before the process is forced down. */
  timeoutMs: number;
}

/**
 * Runs registered teardown tasks exactly once, in reverse registration order.
 *
 * Reverse order matters: a task registered later may depend on one registered
 * earlier (a queue consumer needs its Redis connection), so the most dependent
 * resource is always released first.
 *
 * The controller is deliberately independent of the process signal handlers so
 * that shutdown behaviour can be tested without sending real signals.
 */
export class ShutdownController {
  readonly #tasks: ShutdownTask[] = [];
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  #shutdownPromise: Promise<void> | undefined;

  constructor({ logger, timeoutMs }: ShutdownControllerOptions) {
    this.#logger = logger;
    this.#timeoutMs = timeoutMs;
  }

  /** True once {@link shutdown} has been called. */
  get isShuttingDown(): boolean {
    return this.#shutdownPromise !== undefined;
  }

  register(task: ShutdownTask): void {
    if (this.isShuttingDown) {
      throw new Error(`Cannot register "${task.name}" while shutting down.`);
    }

    this.#tasks.push(task);
  }

  /**
   * Releases every registered resource.
   *
   * Concurrent or repeated calls share the first invocation's promise: a
   * platform that sends `SIGTERM` twice must not tear the process down twice.
   */
  shutdown(reason: string): Promise<void> {
    this.#shutdownPromise ??= this.#run(reason);
    return this.#shutdownPromise;
  }

  async #run(reason: string): Promise<void> {
    this.#logger.info({ reason, tasks: this.#tasks.length }, 'shutdown started');

    const deadline = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => {
        resolve('timeout');
      }, this.#timeoutMs);
      // A pending deadline must not keep the event loop alive on a clean exit.
      timer.unref?.();
    });

    const outcome = await Promise.race([this.#disposeAll(), deadline]);

    if (outcome === 'timeout') {
      this.#logger.error(
        { reason, timeoutMs: this.#timeoutMs },
        'shutdown timed out; remaining work was abandoned',
      );
      return;
    }

    this.#logger.info({ reason }, 'shutdown complete');
  }

  async #disposeAll(): Promise<'done'> {
    for (const task of [...this.#tasks].reverse()) {
      try {
        await task.dispose();
        this.#logger.debug({ task: task.name }, 'resource released');
      } catch (error) {
        // One failing resource must not strand the others.
        this.#logger.error({ task: task.name, err: error }, 'failed to release resource');
      }
    }

    return 'done';
  }
}
