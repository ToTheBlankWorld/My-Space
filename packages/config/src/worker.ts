import { LOG_LEVELS } from '@space/types';
import {
  httpUrlSchema,
  nonEmptyStringSchema,
  portSchema,
} from '@space/validation';
import { z } from 'zod';

import { assertServerRuntime, defineEnv, type EnvSource } from './define-env';
import { nodeEnvSchema } from './node-env';

const SCOPE = '@space/worker';

/**
 * Environment for the standalone worker process.
 *
 * The worker is deployed independently (Railway) and must boot with no `.env`
 * file present, so every variable here has a safe default. Background work
 * runs entirely on PostgreSQL (durable job rows + schedules) — there is no
 * Redis configuration.
 */
export const workerEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  /** Identifies this process in logs and, later, in queue consumer names. */
  WORKER_NAME: nonEmptyStringSchema.default('space-worker'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Port for the health endpoint the platform polls. */
  HEALTH_PORT: portSchema.default(8080),
  /** Milliseconds allowed for in-flight work to finish before a forced exit. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).max(120_000).default(10_000),

  /**
   * PostgreSQL connection.
   *
   * Required for the queue consumers and database health probe. When absent
   * the worker still boots (for local development without a database), but
   * queue consumers are not started.
   */
  DATABASE_URL: nonEmptyStringSchema.optional(),

  /**
   * Milliseconds a database readiness probe may wait before declaring the
   * database unreachable.
   *
   * Defaults to 5,000: observed production round trips occasionally take
   * 2–2.5s through the pooled connection, so the previous 2s cap produced
   * false "degraded" reports during otherwise healthy rolling deploys.
   */
  DATABASE_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),

  /**
   * How often (in minutes) to run automatic calendar sync.
   * Default: 15 minutes. Minimum: 5 minutes.
   */
  CALENDAR_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(15),

  /**
   * Hard cap on tasks a single planning pass may schedule.
   *
   * A guard against pathological days: if the user somehow accumulates more
   * tasks than this, the pass fails loudly instead of scheduling for hours.
   */
  PLANNING_MAX_TASKS_PER_PLAN: z.coerce.number().int().min(1).max(2000).default(100),

  /**
   * Google OAuth client ID.
   * Needed to refresh tokens when they expire during sync.
   */
  GOOGLE_CLIENT_ID: nonEmptyStringSchema.optional(),
  GOOGLE_CLIENT_SECRET: nonEmptyStringSchema.optional(),

  /**
   * OAuth encryption key for decrypting stored tokens.
   * Same format as in @space/config/auth: `<keyId>:<base64 key>`.
   */
  OAUTH_ENCRYPTION_KEY: nonEmptyStringSchema.optional(),
  OAUTH_ENCRYPTION_PREVIOUS_KEYS: z.string().optional(),

  /**
   * Public base URL of the web app.
   *
   * Used to build absolute, clickable links inside notification emails and
   * in-app notification bodies.
   */
  APP_URL: httpUrlSchema.default('http://localhost:3000'),

  /**
   * AgentMail API key for the email delivery provider.
   *
   * Optional: when absent the worker still boots, but outbound email attempts
   * are recorded as failed (`provider-not-configured`) rather than silently
   * dropped or faked. Never logged.
   */
  AGENTMAIL_API_KEY: nonEmptyStringSchema.optional(),

  /**
   * AgentMail API base URL. Point at a sandbox when testing locally.
   */
  AGENTMAIL_BASE_URL: httpUrlSchema.default('https://api.agentmail.dev'),

  /**
   * How often (in minutes) the notification sweep runs: reminder dispatch,
   * outbox consumption and enqueueing due notifications for delivery.
   */
  NOTIFICATION_SWEEP_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(60).default(5),

  /**
   * How often (in minutes) the autonomy review runs: observes real-world signals,
   * detects at-risk deadlines, classifies calendar drift, and delegates replans.
   */
  AUTONOMY_REVIEW_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(60).default(5),

  /**
   * How often (in minutes) the maintenance job runs: data-retention prunes,
   * expired-session and verification cleanup, calendar-event tombstone purging.
   * Minimum 60, default 1440 (once a day).
   */
  MAINTENANCE_INTERVAL_MINUTES: z.coerce.number().int().min(60).max(1440).default(1440),

  /**
   * Retention windows, in days, for the rows the maintenance job prunes.
   *
   * The event log is additionally bounded below by the smallest commited outbox
   * cursor, so reducing these windows can never break a lagging consumer.
   */
  EVENT_LOG_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
  AGENT_ACTION_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
  NOTIFICATION_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
  EMAIL_LOG_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
  /** How long an authenticated session is kept after it expires. */
  SESSION_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /** How long a one-time OAuth state / verification is kept after it expires. */
  VERIFICATION_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  /** How long a calendar-event tombstone is kept before being purged. */
  CALENDAR_EVENT_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
});

export type WorkerEnv = z.output<typeof workerEnvSchema>;

/** Loads and validates the worker environment. Throws on the first bad value. */
export const loadWorkerEnv = (source?: EnvSource): Readonly<WorkerEnv> => {
  assertServerRuntime(SCOPE);
  return defineEnv(SCOPE, workerEnvSchema, source);
};
