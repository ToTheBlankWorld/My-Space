import { createAutonomyService, type AutonomyServiceDeps } from '@space/autonomy';
import type { Database } from '@space/database';
import type { Logger } from '@space/logger';
import type { Clock } from '@space/time';
import { QUEUE_NAMES, QUEUE_PREFIX } from '@space/types';
import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import type { AutonomyReviewJobPayload, QueueDefinitions } from '.';
import { attachFailureLogging, WORKER_OPTIONS } from '.';

/**
 * Autonomy review worker.
 *
 * One job runs one full review pass over all users with planning preferences.
 * The review never plans directly: it classifies change events, detects
 * elapsed blocks and at-risk deadlines, then delegates every affected day to
 * the planning queue via coalesced jobs.
 */
export interface AutonomyWorkerDeps {
  logger: Logger;
  connection: Redis;
  db: Database;
  clock: Clock;
  queues: QueueDefinitions;
  appUrl: string;
  maxReviewUsers?: number;
}

export const createAutonomyReviewWorker = ({
  db,
  clock,
  logger,
  connection,
  queues,
  appUrl,
  maxReviewUsers,
}: AutonomyWorkerDeps): Worker => {
  const enqueueReplan: AutonomyServiceDeps['enqueueReplan'] = async (request) => {
    const jobId = `space:replan:${request.spaceId}`;
    await queues.planning.add(
      'autonomous-replan',
      {
        userId: request.userId,
        spaceId: request.spaceId,
        date: request.date,
        planVersion: request.planVersion,
        trigger: 'autonomous',
      },
      { jobId },
    );
  };

  const service = createAutonomyService({
    db,
    clock,
    logger,
    appUrl,
    enqueueReplan,
    maxReviewUsers,
  });

  const worker = new Worker<AutonomyReviewJobPayload>(
    QUEUE_NAMES.autonomyReview,
    async (_job: Job<AutonomyReviewJobPayload>) => {
      const summary = await service.review();
      return { success: true, summary };
    },
    {
      connection,
      prefix: QUEUE_PREFIX,
      concurrency: 1,
      limiter: {
        max: 2,
        duration: 120_000,
      },
      lockDuration: WORKER_OPTIONS.lockDuration,
      maxStalledCount: WORKER_OPTIONS.maxStalledCount,
    },
  );

  attachFailureLogging(worker, logger);
  return worker;
};
