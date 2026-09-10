import { audit, type Database } from '@space/database';
import type { PlanningInput, PlanningResult, ProposedAction } from '@space/engine';
import type { Clock } from '@space/time';
import { z } from 'zod';

import type { PlanMode } from './types';

/**
 * Atomically persists one planning pass under the autonomy policy.
 *
 * The version claim is a compare-and-swap: the transaction only proceeds when
 * the space still holds the `planVersion` the plan was computed against, so a
 * foreground edit or a concurrent pass can never be clobbered by a stale write.
 *
 * Autonomy is enforced at this boundary, never in the engine:
 *   - `SUGGEST_ONLY`          — no task or space-item writes; every proposed
 *                               action is recorded with an `SKIPPED` outcome.
 *   - `ASK_BEFORE_CHANGING`   — new placements are applied, but an item already
 *                               on the day is never moved.
 *   - `AUTOMATICALLY_MANAGE`  — the full plan is applied.
 */

export interface PersistPlanningArgs {
  userId: string;
  spaceId: string;
  planVersion: number;
  correlationId: string;
  input: PlanningInput;
  result: PlanningResult;
}

export interface PersistOutcome {
  applied: boolean;
  mode: PlanMode;
  skipped?: 'stale-version';
}

const REASON_LIMIT = 500;

export const persistPlanningResult = async (
  db: Database,
  clock: Clock,
  args: PersistPlanningArgs,
): Promise<PersistOutcome> => {
  const { userId, spaceId, planVersion, correlationId, input, result } = args;
  const autonomy = input.planningPreferences.autonomyLevel;

  // SUGGEST_ONLY never touches task or space-item rows; the plan is recorded as
  // an audit trail only.
  if (autonomy === 'SUGGEST_ONLY') {
    await db.$transaction(async (tx) => {
      await recordActions(tx, userId, {
        spaceId,
        correlationId,
        actions: result.proposedActions,
        outcome: 'SKIPPED',
        durationMs: result.durationMs,
      });
    });
    return { applied: false, mode: 'suggest-only' };
  }

  const now = clock.now();
  const applyMoves = autonomy === 'AUTOMATICALLY_MANAGE';

  return db.$transaction(async (tx) => {
    // Claim the version. `updateMany` with the exact expected version is the
    // compare-and-swap: exactly one concurrent pass wins.
    const claimed = await tx.space.updateMany({
      where: { id: spaceId, userId, planVersion },
      data: { plannedAt: now, optimizedAt: now, planVersion: { increment: 1 }, status: 'ACTIVE' },
    });

    if (claimed.count === 0) {
      return {
        applied: applyMoves,
        mode: applyMoves ? 'applied' : 'ask-before-changing',
        skipped: 'stale-version' as const,
      };
    }

    if (applyMoves) {
      await applyFullPlan(tx, { userId, spaceId, result });
    } else {
      await applyNewPlacements(tx, { userId, spaceId, result, existingItems: input.existingItems });
    }

    const outcome = applyMoves ? 'SUCCEEDED' : 'SKIPPED';
    await recordActions(tx, userId, {
      spaceId,
      correlationId,
      actions: result.proposedActions,
      outcome,
      durationMs: result.durationMs,
    });

    return { applied: applyMoves, mode: applyMoves ? 'applied' : 'ask-before-changing' };
  });
};

// ---------------------------------------------------------------------------
// Plan application
// ---------------------------------------------------------------------------

const applyFullPlan = async (
  tx: Database,
  { userId, spaceId, result }: { userId: string; spaceId: string; result: PlanningResult },
): Promise<void> => {
  let position = 0;
  for (const block of result.scheduledBlocks) {
    if (block.kind === 'CALENDAR_EVENT') {
      // Calendar events are anchors; the engine never moves them.
      continue;
    }
    if (block.kind === 'TASK') {
      await tx.task.updateMany({
        where: { id: block.itemId, userId },
        data: { scheduledStart: block.start, scheduledEnd: block.end },
      });
      await tx.spaceItem.upsert({
        where: { taskId: block.itemId },
        create: {
          userId,
          spaceId,
          kind: 'TASK',
          taskId: block.itemId,
          position,
          scheduledStart: block.start,
          scheduledEnd: block.end,
        },
        update: {
          spaceId,
          position,
          scheduledStart: block.start,
          scheduledEnd: block.end,
        },
      });
    } else if (block.kind === 'REMINDER') {
      await tx.spaceItem.upsert({
        where: { reminderId: block.itemId },
        create: {
          userId,
          spaceId,
          kind: 'REMINDER',
          reminderId: block.itemId,
          position,
          scheduledStart: block.start,
        },
        update: { spaceId, position, scheduledStart: block.start },
      });
    }
    position += 1;
  }
};

const applyNewPlacements = async (
  tx: Database,
  {
    userId,
    spaceId,
    result,
    existingItems,
  }: {
    userId: string;
    spaceId: string;
    result: PlanningResult;
    existingItems: PlanningInput['existingItems'];
  },
): Promise<void> => {
  // In ASK_BEFORE_CHANGING mode only placements for items with no existing
  // SpaceItem are applied; already-placed items are left exactly where the
  // user put them. An item is keyed by its own row id, so membership in the
  // existing timeline is the relevant check.
  const alreadyOnDay = new Set(
    existingItems
      .map((item) => item.taskId ?? item.reminderId ?? item.calendarEventId)
      .filter((id): id is string => id !== null),
  );

  let position = 0;
  for (const block of result.scheduledBlocks) {
    if (block.kind === 'CALENDAR_EVENT') {
      continue;
    }
    if (alreadyOnDay.has(block.itemId)) {
      continue;
    }

    if (block.kind === 'TASK') {
      await tx.spaceItem.create({
        data: {
          userId,
          spaceId,
          kind: 'TASK',
          taskId: block.itemId,
          position,
          scheduledStart: block.start,
          scheduledEnd: block.end,
        },
      });
      await tx.task.updateMany({
        where: { id: block.itemId, userId },
        data: { scheduledStart: block.start, scheduledEnd: block.end },
      });
    } else if (block.kind === 'REMINDER') {
      await tx.spaceItem.create({
        data: {
          userId,
          spaceId,
          kind: 'REMINDER',
          reminderId: block.itemId,
          position,
          scheduledStart: block.start,
        },
      });
    }
    position += 1;
  }
};

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

interface RecordActionsArgs {
  spaceId: string;
  correlationId: string;
  actions: ProposedAction[];
  outcome: 'SUCCEEDED' | 'SKIPPED';
  durationMs: number;
}

const recordActions = async (
  tx: Database,
  userId: string,
  args: RecordActionsArgs,
): Promise<void> => {
  for (const action of args.actions) {
    await audit.recordAgentAction(tx, userId, {
      actionType: action.actionType,
      outcome: args.outcome,
      entityType: action.entityType,
      entityId: action.entityId || null,
      spaceId: args.spaceId,
      reason: action.reason.slice(0, REASON_LIMIT),
      factors: asJson(action.factors),
      previousState: asJson(action.previousState),
      resultingState: asJson(action.resultingState),
      correlationId: args.correlationId,
      durationMs: args.durationMs,
    });
  }
};

const asJson = (value: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
  value && Object.keys(value).length > 0 ? value : undefined;

// ---------------------------------------------------------------------------
// The completed-plan payload, persisted with the PLANNING_COMPLETED event.
//
// This is what the UI reads back to show an authoritative day after a refresh.
// It is deliberately bounded to the plan's summary — counts, conflicts and
// explanations — never the full set of scheduled blocks, which are already rows.
// ---------------------------------------------------------------------------

export const planningCompletedPayloadSchema = z.object({
  mode: z.enum(['applied', 'ask-before-changing', 'suggest-only']),
  scheduled: z.number().int().nonnegative(),
  unscheduled: z.number().int().nonnegative(),
  conflicts: z
    .array(
      z.object({
        type: z.string(),
        itemIds: z.array(z.string()),
        description: z.string(),
        resolution: z.string(),
        reasonCode: z.string(),
      }),
    )
    .default([]),
  explanations: z
    .array(
      z.object({
        itemId: z.string(),
        kind: z.string(),
        reasonCode: z.string(),
        message: z.string(),
      }),
    )
    .default([]),
  planVersion: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
});

export type PlanningCompletedPayload = z.infer<typeof planningCompletedPayloadSchema>;

const MAX_CONFLICTS = 50;
const MAX_EXPLANATIONS = 100;

export const buildPlanningCompletedPayload = (
  result: PlanningResult,
  mode: PlanMode,
): PlanningCompletedPayload => ({
  mode,
  scheduled: result.scheduledBlocks.length,
  unscheduled: result.unscheduledTasks.length,
  conflicts: result.conflicts.slice(0, MAX_CONFLICTS).map((conflict) => ({
    type: conflict.type,
    itemIds: conflict.itemIds,
    description: conflict.description,
    resolution: conflict.resolution,
    reasonCode: conflict.reasonCode,
  })),
  explanations: result.explanations.slice(0, MAX_EXPLANATIONS).map((explanation) => ({
    itemId: explanation.itemId,
    kind: explanation.kind,
    reasonCode: explanation.reasonCode,
    message: explanation.message,
  })),
  planVersion: result.planVersion,
  durationMs: result.durationMs,
});
