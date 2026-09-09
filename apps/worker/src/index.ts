import { loadWorkerEnv } from '@space/config/worker';
import { createLogger } from '@space/logger';

import { connectDatabase } from './database';
import { createHealthServer, type ReadinessProbe, type RuntimeState } from './health/server';
import { installProcessSignalHandlers } from './lifecycle/process-signals';
import { ShutdownController } from './lifecycle/shutdown';

/**
 * Worker entry point.
 *
 * The worker is an ordinary long-lived Node process with no dependency on the
 * Next.js runtime, so it can be deployed and scaled on its own (Railway) and is
 * never subject to serverless execution limits.
 *
 * The process contract is configuration, logging, health endpoints and graceful
 * shutdown; Stage 2 adds an optional database pool that reports through
 * readiness. Queue consumers and the deterministic Space Engine attach to the
 * same lifecycle in later stages.
 */
const bootstrap = async (): Promise<void> => {
  const env = loadWorkerEnv();

  const logger = createLogger({
    name: env.WORKER_NAME,
    level: env.LOG_LEVEL,
    bindings: { environment: env.NODE_ENV },
  });

  const state: RuntimeState = { ready: false };

  const shutdown = new ShutdownController({ logger, timeoutMs: env.SHUTDOWN_TIMEOUT_MS });

  // Stop advertising readiness first: the platform drains this instance while
  // the remaining resources are still releasing.
  shutdown.register({
    name: 'readiness',
    dispose: () => {
      state.ready = false;
    },
  });

  // The database is optional at this stage; without it the worker still boots.
  const probes: ReadinessProbe[] = [];

  if (env.DATABASE_URL) {
    const database = connectDatabase({ connectionString: env.DATABASE_URL, logger });
    probes.push(database.probe);
    shutdown.register({ name: 'database', dispose: database.dispose });
    logger.info('database pool opened');
  } else {
    logger.warn('DATABASE_URL is not set; the worker is running without persistence');
  }

  const health = createHealthServer({ logger, state, serviceName: env.WORKER_NAME, probes });
  await health.listen(env.HEALTH_PORT);
  shutdown.register({ name: 'health-server', dispose: () => health.close() });

  installProcessSignalHandlers({ controller: shutdown, logger });

  state.ready = true;

  logger.info(
    {
      healthPort: env.HEALTH_PORT,
      shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      databaseConnected: probes.length > 0,
      nodeVersion: process.version,
    },
    'worker ready',
  );
};

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet if configuration itself failed.
  console.error('[space-worker] fatal error during bootstrap');
  console.error(error);
  process.exitCode = 1;
});
