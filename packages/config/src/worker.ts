import { LOG_LEVELS } from '@space/types';
import { nonEmptyStringSchema, portSchema } from '@space/validation';
import { z } from 'zod';

import { assertServerRuntime, defineEnv, type EnvSource } from './define-env';
import { nodeEnvSchema } from './node-env';

const SCOPE = '@space/worker';

/**
 * Environment for the standalone worker process.
 *
 * The worker is deployed independently (Railway) and must boot with no `.env`
 * file present, so every variable in this stage has a safe default. Connection
 * strings (`DATABASE_URL`, `REDIS_URL`) become required entries here when the
 * queue and persistence layers land.
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
   * Optional PostgreSQL connection.
   *
   * When present the worker opens a pool at boot and reports database
   * reachability through `/readyz`. When absent it still boots: this stage has
   * no queue consumers, and a developer must be able to run the process without
   * standing up a database first.
   */
  DATABASE_URL: nonEmptyStringSchema.optional(),
});

export type WorkerEnv = z.output<typeof workerEnvSchema>;

/** Loads and validates the worker environment. Throws on the first bad value. */
export const loadWorkerEnv = (source?: EnvSource): Readonly<WorkerEnv> => {
  assertServerRuntime(SCOPE);
  return defineEnv(SCOPE, workerEnvSchema, source);
};
