import { createKeyring } from '@space/auth';
import type { GoogleClientCredentials } from '@space/calendar';
import { loadWorkerEnv } from '@space/config/worker';
import { createLogger } from '@space/logger';
import { createMetrics } from '@space/metrics';
import { createEmailProvider } from '@space/notifications';
import { SystemClock } from '@space/time';
import type { Redis } from 'ioredis';

import { connectDatabase, type DatabaseConnection } from './database';
import { createHealthServer, type ReadinessProbe, type RuntimeState } from './health/server';
import { installProcessSignalHandlers } from './lifecycle/process-signals';
import { ShutdownController } from './lifecycle/shutdown';
import {
  attachJobMetrics,
  createJobMetrics,
  createQueues,
  createRedisConnection,
  createRedisHealth,
  type QueueDefinitions,
} from './queues';
import { createCalendarSyncWorker } from './queues/calendar-sync-worker';
import { createMaintenanceWorker } from './queues/maintenance-worker';
import { createNotificationWorker } from './queues/notification-worker';
import { createPlanningWorker } from './queues/planning-worker';
import {
  scheduleAutoSyncs,
  scheduleNotificationSweep,
  scheduleAutonomyReview,
  scheduleMaintenance,
} from './scheduler';
import { createAutonomyReviewWorker } from './queues/autonomy-review-worker';

/**
 * Worker entry point.
 *
 * The worker is an ordinary long-lived Node process with no dependency on the
 * Next.js runtime, so it can be deployed and scaled on its own (Railway) and is
 * never subject to serverless execution limits.
 *
 * The process contract is configuration, logging, health endpoints and graceful
 * shutdown; Stage 4 adds Redis/BullMQ queue consumers that own background
 * execution of calendar sync, token refresh, and maintenance tasks.
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
  // Shared job metric families for every queue worker in this process.
  const jobMetrics = createJobMetrics(metrics);

  const shutdown = new ShutdownController({ logger, timeoutMs: env.SHUTDOWN_TIMEOUT_MS });

  // Stop advertising readiness first: the platform drains this instance while
  // the remaining resources are still releasing.
  shutdown.register({
    name: 'readiness',
    dispose: () => {
      state.ready = false;
    },
  });

  // Database: optional at bootstrap, required for queue consumers.
  const probes: ReadinessProbe[] = [];
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
    logger.warn('DATABASE_URL is not set; the worker is running without persistence');
  }

  // Redis + BullMQ: optional at bootstrap, required for queue consumers.
  let redisConnection: Redis | undefined;
  let queues: QueueDefinitions | undefined;
  let calendarSyncWorker: ReturnType<typeof createCalendarSyncWorker> | undefined;
  let maintenanceWorker: ReturnType<typeof createMaintenanceWorker> | undefined;
  let planningWorker: ReturnType<typeof createPlanningWorker> | undefined;
  let notificationWorker: ReturnType<typeof createNotificationWorker> | undefined;
  let autonomyReviewWorker: ReturnType<typeof createAutonomyReviewWorker> | undefined;

  if (env.REDIS_URL) {
    redisConnection = createRedisConnection(env.REDIS_URL);
    await redisConnection.connect();
    shutdown.register({
      name: 'redis',
      dispose: async () => {
        await redisConnection?.quit();
      },
    });

    const redisHealth = createRedisHealth(redisConnection);
    probes.push(redisHealth.probe);

    queues = createQueues(redisConnection);

    // Start queue consumers. The calendar sync worker additionally needs the
    // database, a token keyring and Google OAuth credentials; without them it
    // must not start, so it is only created when all are present and configured.
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

    if (database && google && keyring) {
      calendarSyncWorker = createCalendarSyncWorker({
        logger,
        connection: redisConnection,
        db: database.client,
        clock: new SystemClock(),
        keyring,
        google,
      });

      await scheduleAutoSyncs({
        db: database.client,
        queues,
        intervalMinutes: env.CALENDAR_SYNC_INTERVAL_MINUTES,
        logger,
      });
      attachJobMetrics(calendarSyncWorker, jobMetrics, 'space:calendar-sync');
      logger.info('calendar sync worker started');
    } else {
      logger.warn(
        {
          database: database !== undefined,
          googleConfigured: google !== undefined,
          keyringConfigured: keyring !== undefined,
        },
        'calendar sync worker disabled: database, google or keyring configuration missing',
      );
    }

    if (database) {
      maintenanceWorker = createMaintenanceWorker({
        logger,
        connection: redisConnection,
        db: database.client,
        clock: new SystemClock(),
        metrics,
        retention: {
          eventLogDays: env.EVENT_LOG_RETENTION_DAYS,
          agentActionDays: env.AGENT_ACTION_RETENTION_DAYS,
          notificationDays: env.NOTIFICATION_RETENTION_DAYS,
          emailLogDays: env.EMAIL_LOG_RETENTION_DAYS,
          sessionDays: env.SESSION_RETENTION_DAYS,
          verificationDays: env.VERIFICATION_RETENTION_DAYS,
          calendarEventTombstoneDays: env.CALENDAR_EVENT_RETENTION_DAYS,
        },
      });

      await scheduleMaintenance({
        queues,
        intervalMinutes: env.MAINTENANCE_INTERVAL_MINUTES,
        logger,
      });
      attachJobMetrics(maintenanceWorker, jobMetrics, 'space:maintenance');

      logger.info('maintenance worker started');
    } else {
      logger.warn('maintenance worker disabled: database configuration missing');
    }

    // The planning worker needs only the database and a clock; it has no OAuth
    // or provider dependencies, so it starts whenever persistence is present.
    if (database) {
      planningWorker = createPlanningWorker({
        logger,
        connection: redisConnection,
        db: database.client,
        clock: new SystemClock(),
        maxTasksPerPlan: env.PLANNING_MAX_TASKS_PER_PLAN,
      });
      attachJobMetrics(planningWorker, jobMetrics, 'space:planning');
      logger.info('planning worker started');
    } else {
      logger.warn('planning worker disabled: database configuration missing');
    }

    // The notification worker needs the database, a clock, the web base URL for
    // clickable content and an email provider for outbound delivery. The
    // provider is optional: when AgentMail isn't configured the sweep still
    // runs (cycles, reminders, outbox) but prepared emails stay PENDING rather
    // than being faked. The sweep schedule is one repeatable job, so a rolling
    // fleet only ever holds a single schedule.
    if (database) {
      const emailProvider = createEmailProvider({
        baseUrl: env.AGENTMAIL_BASE_URL,
        token: env.AGENTMAIL_API_KEY ?? '',
      });

      notificationWorker = createNotificationWorker({
        logger,
        connection: redisConnection,
        db: database.client,
        clock: new SystemClock(),
        appUrl: env.APP_URL,
        emailProvider,
        queues,
      });

      await scheduleNotificationSweep({
        queues,
        intervalMinutes: env.NOTIFICATION_SWEEP_INTERVAL_MINUTES,
        logger,
      });
      attachJobMetrics(notificationWorker, jobMetrics, 'space:notifications');

      logger.info(
        { emailProviderConfigured: emailProvider !== null },
        'notification worker started',
      );
    } else {
      logger.warn('notification worker disabled: database configuration missing');
    }

    // The autonomy review worker needs the database, a clock and the planning
    // queue. It runs on a fixed interval and never directly modifies tasks —
    // it only classifies signals and delegates replans.
    if (database) {
      autonomyReviewWorker = createAutonomyReviewWorker({
        logger,
        connection: redisConnection,
        db: database.client,
        clock: new SystemClock(),
        queues,
        appUrl: env.APP_URL,
      });

      await scheduleAutonomyReview({
        queues,
        intervalMinutes: env.AUTONOMY_REVIEW_INTERVAL_MINUTES,
        logger,
      });
      attachJobMetrics(autonomyReviewWorker, jobMetrics, 'space:autonomy-review');
      logger.info('autonomy review worker started');
    } else {
      logger.warn('autonomy review worker disabled: database configuration missing');
    }

    shutdown.register({
      name: 'bullmq-workers',
      dispose: async () => {
        await Promise.all([
          calendarSyncWorker?.close(),
          maintenanceWorker?.close(),
          planningWorker?.close(),
          notificationWorker?.close(),
          autonomyReviewWorker?.close(),
        ]);
      },
    });

    shutdown.register({
      name: 'bullmq-queues',
      dispose: async () => {
        await Promise.all([
          queues?.calendarSync.close(),
          queues?.calendarRefresh.close(),
          queues?.maintenance.close(),
          queues?.planning.close(),
          queues?.notifications.close(),
          queues?.autonomyReview.close(),
        ]);
      },
    });

    logger.info('redis connected, bullmq queues started');
  } else {
    logger.warn('REDIS_URL is not set; the worker is running without queue consumers');
  }

  // Health server: always started.
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

  state.ready = true;

  logger.info(
    {
      healthPort: env.HEALTH_PORT,
      shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      databaseConnected: database !== undefined,
      redisConnected: redisConnection !== undefined,
      queuesEnabled: queues !== undefined,
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
