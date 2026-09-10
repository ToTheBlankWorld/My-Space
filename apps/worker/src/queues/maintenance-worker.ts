import type { Logger } from '@space/logger';
import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import type { MaintenanceJobPayload } from '.';

/**
 * Maintenance worker processor.
 *
 * Handles periodic cleanup tasks: expired sessions, stale event tombstones,
 * and other housekeeping. Runs on a schedule via BullMQ repeatable jobs.
 */
export interface MaintenanceWorkerDeps {
  logger: Logger;
  connection: Redis;
}

export const createMaintenanceWorker = ({ logger, connection }: MaintenanceWorkerDeps): Worker => {
  return new Worker<MaintenanceJobPayload>(
    'space:maintenance',
    (job: Job<MaintenanceJobPayload>) => {
      const taskLogger = logger.child({ jobId: job.id, task: job.data.task });

      taskLogger.info('maintenance job started');

      // Real task implementations will be wired at composition time.
      switch (job.data.task) {
        case 'cleanup-expired-sessions':
          taskLogger.info('cleanup-expired-sessions completed');
          break;
        case 'purge-deleted-events':
          taskLogger.info('purge-deleted-events completed');
          break;
      }

      return Promise.resolve({ success: true });
    },
    {
      connection,
      concurrency: 1,
    },
  );
};
