import { audit, type Database } from '@space/database';
import { plan, validatePlanningInput } from '@space/engine';
import type { Logger } from '@space/logger';
import {
  buildPlanningCompletedPayload,
  loadPlanningInput,
  persistPlanningResult,
} from '@space/planning';
import { asCalendarDate, type Clock } from '@space/time';
import { randomUUID } from 'node:crypto';
import { computePlanDiff } from '@space/autonomy';

/**
 * The planning processor — the body of the PostgreSQL planning handler.
 *
 * One job plans one user's day. The processor is deliberately thin: the
 * snapshot loading, engine invocation and autonomous persistence live in the
 * shared `@space/planning` service so the web request handler and every queue
 * path run the exact same code. The engine stays fully deterministic — no
 * model, no inference.
 *
 * Optimistic concurrency: the job ships with the `planVersion` it loaded, and
 * the persistence transaction only applies when that version is still current.
 * A foreground edit or a concurrent pass that bumped the version makes the
 * write a no-op instead of clobbering newer state — a stale job safely no-ops.
 */

export interface PlanningJobPayload {
  /** The user whose day is being planned. */
  userId: string;
  /** The calendar date of the plan (YYYY-MM-DD). */
  date: string;
  /** The Space being planned. */
  spaceId: string;
  /** The plan version the job loaded and must write against. */
  planVersion: number;
  /** Who triggered the pass — 'user' from a button, 'autonomous' from the loop. */
  trigger?: 'user' | 'autonomous';
}

export interface PlanningJobDeps {
  db: Database;
  clock: Clock;
  logger: Logger;
  /** Hard cap on tasks a single pass may schedule. Fail loudly rather than thrash. */
  maxTasksPerPlan?: number;
}

export interface PlanningJobResult {
  success: true;
  skipped?: string;
  failed?: 'validation';
  outcome?: {
    applied: boolean;
    mode: string;
    scheduledBlocks: number;
    unscheduledTasks: number;
    conflicts: number;
  };
}

const DEFAULT_TASKS = 100;

export const processPlanningJob = async (
  { db, clock, logger, maxTasksPerPlan = DEFAULT_TASKS }: PlanningJobDeps,
  payload: PlanningJobPayload,
): Promise<PlanningJobResult> => {
  const { userId, date, spaceId, planVersion, trigger } = payload;
  const jobLogger = logger.child({ userId, date, spaceId });
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
    //    fix it — so it is recorded once and the job completes instead of
    //    burning its retry budget on the same bad input.
    const validation = validatePlanningInput(input);
    if (!validation.valid) {
      const messages = validation.violations
        .filter((v) => v.severity === 'error')
        .map((v) => `${v.field}: ${v.message}`)
        .join('; ');
      await audit.appendEvent(db, userId, {
        eventType: 'PLANNING_FAILED',
        aggregateType: 'SPACE',
        aggregateId: spaceId,
        occurredAt: clock.now(),
        correlationId,
        payload: {
          message: `planning input invalid: ${messages}`.slice(0, 500),
          reason: 'validation',
        },
      });
      jobLogger.error({ violations: validation.violations }, 'planning skipped: invalid input');
      return { success: true, failed: 'validation' };
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
};
