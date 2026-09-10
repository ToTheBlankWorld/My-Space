import { audit, type Database } from '@space/database';
import { plan, validatePlanningInput, type PlanningResult } from '@space/engine';
import type { Logger } from '@space/logger';
import {
  buildPlanningCompletedPayload,
  loadPlanningInput,
  persistPlanningResult,
} from '@space/planning';
import type { PlanMode } from '@space/planning';
import { asCalendarDate, type Clock } from '@space/time';
import { Worker, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { computePlanDiff } from '@space/autonomy';

import type { PlanningJobPayload } from '.';

/**
 * Planning worker processor.
 *
 * One job plans one user's day. The worker is deliberately thin: it owns the
 * queue mechanics (claiming a job, marking it done, retrying on failure), while
 * the snapshot loading, engine invocation and autonomous persistence live in the
 * shared `@space/planning` service so the web request handler and the queue run
 * the exact same code.
 *
 * Optimistic concurrency: the job ships with the `planVersion` it loaded, and
 * the persistence transaction only applies when that version is still current.
 * A foreground edit or a concurrent pass that bumped the version makes the
 * write a no-op instead of clobbering newer state.
 */

export interface PlanningWorkerDeps {
  logger: Logger;
  connection: Redis;
  db: Database;
  clock: Clock;
  /** Hard cap on tasks a single pass may schedule. Fail loudly rather than thrash. */
  maxTasksPerPlan?: number;
}

const DEFAULT_TASKS = 100;

export interface PlanningOutcome {
  applied: boolean;
  mode: PlanMode;
  result: PlanningResult;
}

export const createPlanningWorker = ({
  db,
  clock,
  logger,
  connection,
  maxTasksPerPlan = DEFAULT_TASKS,
}: PlanningWorkerDeps): Worker => {
  return new Worker<PlanningJobPayload>(
    'space:planning',
    async (job: Job<PlanningJobPayload>) => {
      const { userId, date, spaceId, planVersion, trigger } = job.data;
      const jobLogger = logger.child({ jobId: job.id, userId, date, spaceId });
      const correlationId = randomUUID();
      const startedAt = clock.now();

      jobLogger.info({ planVersion }, 'planning job started');

      await audit.appendEvent(db, userId, {
        eventType: 'PLANNING_STARTED',
        aggregateType: 'SPACE',
        aggregateId: spaceId,
        occurredAt: startedAt,
        correlationId,
      });

      try {
        // 1. Load the snapshot. The version the job carries must match what the
        //    database still holds; anything else means the job is stale.
        const space = await db.space.findFirst({
          where: { id: spaceId, userId },
          select: { id: true, planVersion: true, status: true, timeZone: true },
        });

        if (!space) {
          jobLogger.error('planning skipped: space not found or not owned by user');
          return { success: true, skipped: 'space-not-found' };
        }

        if (space.planVersion !== planVersion) {
          jobLogger.info(
            { expected: planVersion, actual: space.planVersion },
            'planning skipped: stale plan version',
          );
          return { success: true, skipped: 'stale-version' };
        }

        const input = await loadPlanningInput(db, jobLogger, {
          userId,
          date: asCalendarDate(date),
          spaceId,
          space: {
            id: space.id,
            planVersion: space.planVersion,
            status: space.status,
          },
          maxTasksPerPlan,
        });

        // 2. Run the engine. Validation failure is permanent — retrying will not
        //    fix it — so it surfaces as a failed job rather than a retry loop.
        const validation = validatePlanningInput(input);
        if (!validation.valid) {
          const messages = validation.violations
            .filter((v) => v.severity === 'error')
            .map((v) => `${v.field}: ${v.message}`)
            .join('; ');
          throw new Error(`planning input invalid: ${messages}`);
        }

        const result = plan(input, clock);
        jobLogger.info(
          {
            scheduled: result.scheduledBlocks.length,
            unscheduled: result.unscheduledTasks.length,
            conflicts: result.conflicts.length,
            durationMs: result.durationMs,
          },
          'plan computed',
        );

        // 3. Persist under the autonomy policy, guarded by the version claim.
        const outcome = await persistPlanningResult(db, clock, {
          userId,
          spaceId,
          planVersion,
          correlationId,
          input,
          result,
        });

        if (outcome.skipped) {
          jobLogger.info({ skipped: outcome.skipped }, 'planning skipped during persist');
          return { success: true, skipped: outcome.skipped };
        }

        // 4. Audit the pass.
        await audit.appendEvent(db, userId, {
          eventType: 'PLANNING_COMPLETED',
          aggregateType: 'SPACE',
          aggregateId: spaceId,
          occurredAt: clock.now(),
          correlationId,
          payload: buildPlanningCompletedPayload(result, outcome.mode),
        });

        // 5. For autonomous passes, compute the plan diff and emit SPACE_OPTIMIZED.
        if (trigger === 'autonomous') {
          const diff = computePlanDiff(input.existingItems, input.tasks, result);
          await audit.appendEvent(db, userId, {
            eventType: 'SPACE_OPTIMIZED',
            aggregateType: 'SPACE',
            aggregateId: spaceId,
            occurredAt: clock.now(),
            correlationId,
            payload: {
              planVersion: result.planVersion,
              trigger,
              counts: diff.counts,
              hasMeaningfulChange: diff.hasMeaningfulChange,
              entries: diff.entries.slice(0, 50),
            },
          });
        }

        jobLogger.info(
          { mode: outcome.mode, planVersion: result.planVersion },
          'planning job completed',
        );

        return {
          success: true,
          outcome: {
            applied: outcome.applied,
            mode: outcome.mode,
            scheduledBlocks: result.scheduledBlocks.length,
            unscheduledTasks: result.unscheduledTasks.length,
            conflicts: result.conflicts.length,
          },
        };
      } catch (error) {
        await audit
          .appendEvent(db, userId, {
            eventType: 'PLANNING_FAILED',
            aggregateType: 'SPACE',
            aggregateId: spaceId,
            occurredAt: clock.now(),
            correlationId,
            payload: {
              message: error instanceof Error ? error.message.slice(0, 500) : 'unknown failure',
            },
          })
          .catch(() => {
            // The failure path must never mask the original error with an audit
            // write failure.
          });

        jobLogger.error({ err: error }, 'planning job failed');
        throw error;
      }
    },
    {
      connection,
      concurrency: 2,
      limiter: {
        max: 10,
        duration: 60_000,
      },
    },
  );
};
