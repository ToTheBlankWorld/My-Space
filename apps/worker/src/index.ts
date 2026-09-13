import { createKeyring } from '@space/auth';
import type { GoogleClientCredentials } from '@space/calendar';
import { loadWorkerEnv } from '@space/config/worker';
import { createLogger } from '@space/logger';
import { createMetrics } from '@space/metrics';
import { createEmailProvider } from '@space/notifications';
import { SystemClock } from '@space/time';
import { randomUUID } from 'node:crypto';

import { connectDatabase, type DatabaseConnection } from './database';
import { createHealthServer, type ReadinessProbe, type RuntimeState } from './health/server';
import { installProcessSignalHandlers } from './lifecycle/process-signals';
import { ShutdownController } from './lifecycle/shutdown';
import { createPgHandlers } from './queues/pg/handlers';
import { createPgQueueHealth, type PgQueueRuntimeHealthState } from './queues/pg/health';
import { createPgQueueMetrics } from './queues/pg/metrics';
import { createPgScheduleTicker, registerPgSchedules } from './queues/pg/scheduler';
import { createPgQueueRuntime } from './queues/pg/runtime';

/**
 * Worker entry point.
 *
 * The worker is an ordinary long-lived Node process with no dependency on the
 * Next.js runtime, so it can be deployed and scaled on its own (Railway) and is
 * never subject to serverless execution limits.
 *
 * The process contract is configuration, logging, health endpoints and graceful
 * shutdown. Background work runs entirely on the PostgreSQL durable job queue
 * (`background_jobs` + `job_schedules` — see `@space/database`'s jobs
 * repository): workers claim jobs with `FOR UPDATE SKIP LOCKED` under a lease,
 * retries/backoff/dedupe/coalescing are row-level, and repeatable schedules
 * are claimed fleet-safely by the ticker. There is no Redis, no broker, and no
 * second queue runtime.
 *
 * Rate pacing is process-local (see `queues/pg/pacer.ts`): the deployment
 * assumes a single Railway worker replica.
 */
const bootstrap = async (): Promise<void> => {
  const env = loadWorkerEnv();

  const logger = createLogger({
    name: env.WORKER_NAME,
    level: env.LOG_LEVEL,
    bindings: { environment: env.NODE_ENV },
  });

  const state: RuntimeState = { ready: false };

  // Process-lifetime metrics; exposed at /metrics on the health server.
  const metrics = createMetrics();
  // Created once: the maintenance pass reports its pruned-row counts here.
  const retentionPrunedRows = metrics.gauge({
    name: 'space_retention_pruned_rows',
    help: 'Rows pruned by the latest maintenance pass',
  });

  const shutdown = new ShutdownController({ logger, timeoutMs: env.SHUTDOWN_TIMEOUT_MS });

  // Stop advertising readiness first: the platform drains this instance while
  // the remaining resources are still releasing.
  shutdown.register({
    name: 'readiness',
    dispose: () => {
      state.ready = false;
    },
  });

  const probes: ReadinessProbe[] = [];

  // Database: required. Without persistence there is no queue to run and no
  // state to serve, so the worker is not viable.
  let database: DatabaseConnection | undefined;

  if (env.DATABASE_URL) {
    database = connectDatabase({
      connectionString: env.DATABASE_URL,
      logger,
      healthTimeoutMs: env.DATABASE_HEALTH_TIMEOUT_MS,
    });
    probes.push(database.probe);
    shutdown.register({ name: 'database', dispose: database.dispose });
    logger.info('database pool opened');
  } else {
    logger.error('DATABASE_URL is not set; the worker cannot run without persistence');
  }

  if (database) {
    const clock = new SystemClock();

    // Google OAuth + keyring: required by the calendar sync pipeline; without
    // them that family is disabled (logged, never fatal to the rest).
    const google: GoogleClientCredentials | undefined =
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : undefined;
    const keyring = env.OAUTH_ENCRYPTION_KEY
      ? createKeyring({
          activeKey: env.OAUTH_ENCRYPTION_KEY,
          previousKeys: env.OAUTH_ENCRYPTION_PREVIOUS_KEYS,
        })
      : undefined;

    // Email provider: null when AgentMail isn't configured — deliveries stay
    // PENDING rather than being faked.
    const emailProvider = createEmailProvider({
      baseUrl: env.AGENTMAIL_BASE_URL,
      token: env.AGENTMAIL_API_KEY ?? '',
    });

    // Processor registration: five families with their concurrency lanes.
    const handlerSet = createPgHandlers({
      db: database.client,
      clock,
      logger,
      appUrl: env.APP_URL,
      emailProvider,
      maxTasksPerPlan: env.PLANNING_MAX_TASKS_PER_PLAN,
      retention: {
        eventLogDays: env.EVENT_LOG_RETENTION_DAYS,
        agentActionDays: env.AGENT_ACTION_RETENTION_DAYS,
        notificationDays: env.NOTIFICATION_RETENTION_DAYS,
        emailLogDays: env.EMAIL_LOG_RETENTION_DAYS,
        sessionDays: env.SESSION_RETENTION_DAYS,
        verificationDays: env.VERIFICATION_RETENTION_DAYS,
        calendarEventTombstoneDays: env.CALENDAR_EVENT_RETENTION_DAYS,
      },
      prunedRows: retentionPrunedRows,
      calendar: google && keyring ? { keyring, google } : undefined,
    });

    // PG schedules: repeatable work lives in `job_schedules`. Boot
    // registration is an idempotent upsert (re-anchors the cadence, exactly
    // like the fleet-wide scheduler it replaced) and prunes auto-sync
    // schedules for connections that are no longer CONNECTED.
    await registerPgSchedules({
      db: database.client,
      clock,
      logger,
      intervals: {
        calendarSyncMinutes: env.CALENDAR_SYNC_INTERVAL_MINUTES,
        notificationSweepMinutes: env.NOTIFICATION_SWEEP_INTERVAL_MINUTES,
        autonomyReviewMinutes: env.AUTONOMY_REVIEW_INTERVAL_MINUTES,
        maintenanceMinutes: env.MAINTENANCE_INTERVAL_MINUTES,
      },
      calendarConfigured: google !== undefined && keyring !== undefined,
    });

    // PG runtime: claim loop, lease reaper, queue-depth gauges.
    const pgRuntime = createPgQueueRuntime({
      db: database.client,
      logger,
      workerId: `${env.WORKER_NAME}-${randomUUID()}`,
      classes: handlerSet.classes,
      handlers: handlerSet.handlers,
      metrics: createPgQueueMetrics(metrics),
      clock,
    });
    pgRuntime.start();

    // Schedule ticker: materialises due `job_schedules` rows into jobs.
    const ticker = createPgScheduleTicker({ db: database.client, clock, logger });
    ticker.start();

    // Readiness: database reachable + the queue runtime actually started with
    // handlers registered. A worker whose runtime failed to initialise must
    // not advertise ready.
    const pgQueueState: PgQueueRuntimeHealthState = {
      started: true,
      handlerClasses: handlerSet.classes.length,
    };
    probes.push(createPgQueueHealth(pgQueueState).probe);

    shutdown.register({ name: 'pg-queue-ticker', dispose: () => ticker.stop() });
    shutdown.register({ name: 'pg-queue-runtime', dispose: () => pgRuntime.stop() });

    logger.info(
      {
        classes: handlerSet.classes,
        calendarSyncHandlerEnabled: handlerSet.handlers['calendar-sync'] !== undefined,
      },
      'pg queue runtime started',
    );
  } else {
    logger.error('worker starting in degraded mode: no database, no queue runtime');
  }

  // Health server: always started (so the platform can observe a degraded
  // worker instead of seeing nothing).
  const health = createHealthServer({
    logger,
    state,
    serviceName: env.WORKER_NAME,
    probes,
    metrics: { render: () => metrics.render() },
  });
  await health.listen(env.HEALTH_PORT);
  shutdown.register({ name: 'health-server', dispose: () => health.close() });

  installProcessSignalHandlers({ controller: shutdown, logger });

  // Advertise ready only when the runtime can actually do its job. A worker
  // without its database (or whose runtime failed to start) stays unready so
  // the platform keeps it out of rotation instead of sending it work.
  state.ready = database !== undefined;

  logger.info(
    {
      healthPort: env.HEALTH_PORT,
      shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      databaseConnected: database !== undefined,
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
