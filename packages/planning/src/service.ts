import { audit, spaces, type Database } from '@space/database';
import { plan, validatePlanningInput } from '@space/engine';
import type { Logger } from '@space/logger';
import { isCalendarDate, toCalendarDate, type Clock } from '@space/time';
import type { CalendarDate, SpaceItemKind, TimeZone } from '@space/types';
import { timeZoneSchema } from '@space/validation';
import { randomUUID } from 'node:crypto';

import { loadDayState } from './day-state';
import {
  PlanFailedError,
  PlanInputInvalidError,
  PlanInvalidDateError,
  PlanVersionConflictError,
} from './errors';
import { buildPlanningCompletedPayload, persistPlanningResult } from './persist';
import { loadPlanningInput } from './snapshot';
import type {
  DayState,
  PlanMode,
  PlanSpaceRequest,
  PlanSpaceResult,
  PlannedItemView,
  SpaceView,
  UnplacedTaskView,
} from './types';

/**
 * The plan-my-day application service.
 *
 * One operation, "plan this space", that the web request handler executes now
 * and a worker job can execute later — the same code path, the same engine, the
 * same persistence, the same audit trail. It differs from the engine by
 * contract: it may touch the database, transactions, auth-scoped rows and the
 * event log; the engine stays pure.
 *
 * Concurrency model:
 *  - Rapid duplicate clicks in one process are coalesced by an in-flight key.
 *  - Across processes the database version claim is the source of truth: two
 *    passes racing for the same space resolve to exactly one winner and the
 *    loser observes a {@link PlanVersionConflictError}, never corrupted state.
 *
 * `userId` and every ownership check comes from the session layer. This service
 * never accepts an identity from a browser.
 */

export interface PlanSpaceServiceDeps {
  db: Database;
  clock: Clock;
  logger: Logger;
  /** Hard cap on tasks a single pass may schedule. */
  maxTasksPerPlan?: number;
}

export interface PlanSpaceService {
  /** "Today" as a calendar date in the user's timezone. */
  getToday(userId: string): Promise<{ date: CalendarDate; timeZone: TimeZone }>;
  /** The space for a date, created lazily on first view. */
  getSpaceForDate(userId: string, date: CalendarDate): Promise<SpaceView>;
  /** Runs one complete planning pass and persists it under the autonomy policy. */
  planSpace(request: PlanSpaceRequest): Promise<PlanSpaceResult>;
  /** The authoritative current state of a day, read back from the database. */
  getDayState(request: PlanSpaceRequest): Promise<DayState>;
}

const DEFAULT_TASKS = 100;

export const createPlanSpaceService = (deps: PlanSpaceServiceDeps): PlanSpaceService => {
  const { db, clock, logger, maxTasksPerPlan = DEFAULT_TASKS } = deps;
  const baseLogger = logger.child({ service: 'planning' });
  const inFlight = new Map<string, Promise<PlanSpaceResult>>();

  const resolveTimeZone = async (userId: string): Promise<string | null> => {
    const preferences = await db.userPreferences.findUnique({
      where: { userId },
      select: { timeZone: true },
    });
    return preferences?.timeZone ?? null;
  };

  const assertCalendarDate = (date: CalendarDate): void => {
    if (!isCalendarDate(date)) {
      throw new PlanInvalidDateError(date);
    }
  };

  const getSpaceForDate = async (userId: string, date: CalendarDate): Promise<SpaceView> => {
    assertCalendarDate(date);
    const timeZone = timeZoneSchema.parse((await resolveTimeZone(userId)) ?? 'UTC');
    const row = await spaces.getOrCreateSpace(db, userId, { date, timeZone, status: 'DRAFT' });

    return {
      id: row.id,
      date: row.date,
      timeZone: row.timeZone as TimeZone,
      status: row.status,
      planVersion: row.planVersion,
      plannedAt: row.plannedAt,
    };
  };

  const getToday = async (userId: string): Promise<{ date: CalendarDate; timeZone: TimeZone }> => {
    const timeZone = timeZoneSchema.parse((await resolveTimeZone(userId)) ?? 'UTC');
    return { date: toCalendarDate(clock.now(), timeZone), timeZone };
  };

  const planSpace = async ({ userId, date }: PlanSpaceRequest): Promise<PlanSpaceResult> => {
    const space = await getSpaceForDate(userId, date);
    const key = `${userId}:${space.id}`;

    const existing = inFlight.get(key);
    if (existing) {
      return existing;
    }

    const pending = runPlan({ userId, space });
    inFlight.set(key, pending);
    void pending
      .catch(() => undefined)
      .finally(() => {
        if (inFlight.get(key) === pending) {
          inFlight.delete(key);
        }
      });

    return pending;
  };

  const runPlan = async ({
    userId,
    space,
  }: {
    userId: string;
    space: SpaceView;
  }): Promise<PlanSpaceResult> => {
    const passLogger = baseLogger.child({ userId, spaceId: space.id, date: space.date });
    const correlationId = randomUUID();
    const startedAt = clock.now();

    await audit.appendEvent(db, userId, {
      eventType: 'PLANNING_STARTED',
      aggregateType: 'SPACE',
      aggregateId: space.id,
      occurredAt: startedAt,
      correlationId,
    });

    try {
      // 1. Load the snapshot.
      const input = await loadPlanningInput(db, passLogger, {
        userId,
        date: space.date,
        spaceId: space.id,
        space: { id: space.id, planVersion: space.planVersion, status: space.status },
        maxTasksPerPlan,
      });

      // 2. Run the engine. A validation failure is a permanent property of the
      //    data, not a retryable condition.
      const validation = validatePlanningInput(input);
      if (!validation.valid) {
        const messages = validation.violations
          .filter((v) => v.severity === 'error')
          .map((v) => `${v.field}: ${v.message}`);
        throw new PlanInputInvalidError(messages);
      }

      const result = plan(input, clock);
      passLogger.info(
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
        spaceId: space.id,
        planVersion: space.planVersion,
        correlationId,
        input,
        result,
      });

      if (outcome.skipped) {
        throw new PlanVersionConflictError();
      }

      // 4. Audit the pass.
      await audit.appendEvent(db, userId, {
        eventType: 'PLANNING_COMPLETED',
        aggregateType: 'SPACE',
        aggregateId: space.id,
        occurredAt: clock.now(),
        correlationId,
        payload: buildPlanningCompletedPayload(result, outcome.mode),
      });

      passLogger.info(
        { mode: outcome.mode, planVersion: result.planVersion },
        'planning completed',
      );

      return buildResult(result, outcome.mode, outcome.applied, input, space);
    } catch (error) {
      if (!(error instanceof PlanVersionConflictError)) {
        await audit
          .appendEvent(db, userId, {
            eventType: 'PLANNING_FAILED',
            aggregateType: 'SPACE',
            aggregateId: space.id,
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
      }

      if (error instanceof PlanInputInvalidError || error instanceof PlanVersionConflictError) {
        throw error;
      }

      passLogger.error({ err: error }, 'planning failed');
      throw new PlanFailedError('The day could not be planned.', { cause: error });
    }
  };

  const getDayState = async ({ userId, date }: PlanSpaceRequest): Promise<DayState> => {
    const space = await getSpaceForDate(userId, date);

    return loadDayState(db, {
      userId,
      spaceId: space.id,
      date: space.date,
      timeZone: space.timeZone,
      status: space.status,
      planVersion: space.planVersion,
      plannedAt: space.plannedAt,
      generatedAt: clock.now(),
    });
  };

  return { getToday, getSpaceForDate, planSpace, getDayState };
};

const buildResult = (
  result: Awaited<ReturnType<typeof plan>>,
  mode: PlanMode,
  applied: boolean,
  input: Awaited<ReturnType<typeof loadPlanningInput>>,
  space: SpaceView,
): PlanSpaceResult => {
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  const remindersById = new Map(input.reminders.map((reminder) => [reminder.id, reminder]));
  const eventsById = new Map(input.calendarEvents.map((event) => [event.id, event]));

  const titleFor = (kind: SpaceItemKind, itemId: string): string => {
    if (kind === 'TASK') {
      return tasksById.get(itemId)?.title ?? 'Task';
    }
    if (kind === 'REMINDER') {
      return remindersById.get(itemId)?.title ?? 'Reminder';
    }
    return eventsById.get(itemId)?.title ?? 'Calendar event';
  };

  const scheduledItems: PlannedItemView[] = result.scheduledBlocks.map((block) => ({
    kind: block.kind,
    itemId: block.itemId,
    title: titleFor(block.kind, block.itemId),
    priority: tasksById.get(block.itemId)?.priority ?? null,
    start: block.start,
    end: block.end,
    reasonCode: block.reasonCode,
  }));

  const unscheduledTasks: UnplacedTaskView[] = result.unscheduledTasks.map((unscheduled) => {
    const task = tasksById.get(unscheduled.taskId);
    return {
      taskId: unscheduled.taskId,
      title: task?.title ?? 'Task',
      priority: task?.priority ?? 'NORMAL',
      reasonCode: unscheduled.reasonCode,
      message: unscheduled.message,
    };
  });

  return {
    date: space.date,
    timeZone: space.timeZone,
    spaceId: space.id,
    planVersion: result.planVersion,
    mode,
    applied,
    scheduledItems,
    unscheduledTasks,
    conflicts: result.conflicts,
    changes: result.proposedActions,
    explanations: result.explanations,
    durationMs: result.durationMs,
  };
};
