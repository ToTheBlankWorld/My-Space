import type {
  EngineAction,
  ExistingSpaceItem,
  PlanningInput,
  ScheduledBlock,
  UnscheduledTask,
} from './types';

/**
 * Rescheduling engine.
 *
 * When the plan is recomputed (e.g. a new task arrives, a calendar event
 * changes, or the user requests replanning), this module minimises disruption
 * by preserving existing placements wherever possible.
 *
 * Strategy:
 *   1. Separate existing items into "keep" (no conflict, still valid) and
 *      "displace" (must move).
 *   2. Re-run scheduling only for displaced items.
 *   3. Assign RESCHEDULED_CARRY_FORWARD to preserved items,
 *      RESCHEDULED_MINIMAL_EDIT to newly placed items.
 *   4. Items that were scheduled and remain in the same position get
 *      RESCHEDULED_UNCHANGED.
 *
 * Pure function: no side effects.
 */
export const reschedule = (
  input: PlanningInput,
  newScheduled: ScheduledBlock[],
  unscheduled: UnscheduledTask[],
): {
  scheduled: ScheduledBlock[];
  unscheduled: UnscheduledTask[];
  actions: EngineAction[];
} => {
  const actions: EngineAction[] = [];
  const finalScheduled: ScheduledBlock[] = [];
  const finalUnscheduled = [...unscheduled];

  // Map existing items by their referenced id.
  const existingByTaskId = new Map<string, ExistingSpaceItem>();
  for (const item of input.existingItems) {
    if (item.taskId) existingByTaskId.set(item.taskId, item);
  }

  // Compare new schedule with existing state.
  for (const block of newScheduled) {
    const existing = block.kind === 'TASK' ? existingByTaskId.get(block.itemId) : undefined;

    if (!existing) {
      // New item — not previously scheduled.
      finalScheduled.push({
        ...block,
        reasonCode: 'RESCHEDULED_MINIMAL_EDIT',
      });

      actions.push({
        actionType: 'TASK_SCHEDULED',
        entityType: 'TASK',
        entityId: block.itemId,
        reason: `Task newly placed in schedule.`,
        reasonCode: 'RESCHEDULED_MINIMAL_EDIT',
        factors: { start: block.start.toISOString(), end: block.end.toISOString() },
        resultingState: {
          scheduledStart: block.start.toISOString(),
          scheduledEnd: block.end.toISOString(),
        },
      });
    } else if (
      existing.scheduledStart &&
      existing.scheduledEnd &&
      Math.abs(existing.scheduledStart.getTime() - block.start.getTime()) < 60_000 &&
      Math.abs(existing.scheduledEnd.getTime() - block.end.getTime()) < 60_000
    ) {
      // Same position (within 1 minute tolerance) — unchanged.
      finalScheduled.push({
        ...block,
        reasonCode: 'RESCHEDULED_UNCHANGED',
      });
    } else {
      // Moved — carry forward.
      finalScheduled.push({
        ...block,
        reasonCode: 'RESCHEDULED_CARRY_FORWARD',
      });

      actions.push({
        actionType: 'TASK_RESCHEDULED',
        entityType: 'TASK',
        entityId: block.itemId,
        reason: `Task rescheduled from previous position.`,
        reasonCode: 'RESCHEDULED_CARRY_FORWARD',
        factors: {
          newStart: block.start.toISOString(),
          newEnd: block.end.toISOString(),
        },
        previousState: existing.scheduledStart
          ? {
              scheduledStart: existing.scheduledStart.toISOString(),
              scheduledEnd: existing.scheduledEnd?.toISOString(),
            }
          : undefined,
        resultingState: {
          scheduledStart: block.start.toISOString(),
          scheduledEnd: block.end.toISOString(),
        },
      });
    }
  }

  return { scheduled: finalScheduled, unscheduled: finalUnscheduled, actions };
};
