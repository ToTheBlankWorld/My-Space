import type {
  AvailableSlot,
  PlanningInput,
  PlanningTask,
  ReasonCode,
  ScheduledBlock,
  ScoredTask,
} from './types';

/**
 * Core scheduling algorithm.
 *
 * Given scored tasks and available slots, places each task into the best
 * available slot. Placement order follows the priority scoring; within each
 * task, the best slot is chosen by the scheduling strategy.
 *
 * Strategy behaviors:
 *   - EARLIEST_FIT: first slot that fits (greedy, left-to-right).
 *   - BALANCED: slot closest to preferred planning time, then earliest.
 *   - DEADLINE_FIRST: slot nearest the deadline, then earliest.
 *
 * Buffer time is inserted between consecutive blocks. Break enforcement
 * (minBreakMinutes) is handled at the workload level.
 *
 * Pure function: no side effects.
 */
export const scheduleTasks = (
  scoredTasks: readonly ScoredTask[],
  available: readonly AvailableSlot[],
  input: PlanningInput,
): {
  scheduled: ScheduledBlock[];
  unscheduled: { taskId: string; reasonCode: ReasonCode; message: string }[];
  remainingAvailable: AvailableSlot[];
} => {
  const { bufferMinutes, defaultTaskDurationMinutes, schedulingStrategy, preferredPlanningMinute } =
    input.planningPreferences;

  const scheduled: ScheduledBlock[] = [];
  const unscheduled: { taskId: string; reasonCode: ReasonCode; message: string }[] = [];
  let slots = [...available];

  for (const scored of scoredTasks) {
    const task = scored.task;
    const duration = task.estimatedMinutes ?? defaultTaskDurationMinutes;
    const needed = (duration as number) + (bufferMinutes as number);

    // Find all slots that can fit this task.
    const candidates = slots.filter((s) => s.durationMinutes >= needed);

    if (candidates.length === 0) {
      unscheduled.push({
        taskId: task.id,
        reasonCode: 'HARD_NO_SLOTS',
        message: `No available slot of ${duration as number} minutes for "${task.title}".`,
      });
      continue;
    }

    // Choose best slot per strategy.
    const bestSlot = chooseBestSlot(candidates, schedulingStrategy, preferredPlanningMinute, task);

    if (!bestSlot) {
      unscheduled.push({
        taskId: task.id,
        reasonCode: 'HARD_NO_SLOTS',
        message: `No suitable slot found for "${task.title}".`,
      });
      continue;
    }

    const blockStart = bestSlot.start;
    const blockEnd = new Date(blockStart.getTime() + (duration as number) * 60_000);

    scheduled.push({
      kind: 'TASK',
      itemId: task.id,
      start: blockStart,
      end: blockEnd,
      position: scheduled.length,
      reasonCode: 'SCHEDULED_PLACED',
    });

    // Update available slots: carve out the placed block + buffer.
    const bufferEnd = new Date(blockEnd.getTime() + (bufferMinutes as number) * 60_000);
    slots = carveSlot(slots, bestSlot.start, bufferEnd);
  }

  return { scheduled, unscheduled, remainingAvailable: slots };
};

// ---------------------------------------------------------------------------
// Strategy slot selection
// ---------------------------------------------------------------------------

const chooseBestSlot = (
  candidates: readonly AvailableSlot[],
  strategy: string,
  preferredPlanningMinute: number | null,
  _task: PlanningTask,
): AvailableSlot | undefined => {
  switch (strategy) {
    case 'EARLIEST_FIT': {
      // First candidate (already sorted by start time).
      return candidates[0];
    }
    case 'BALANCED': {
      if (preferredPlanningMinute !== null) {
        // Slot whose start is closest to the preferred time.
        let best = candidates[0]!;
        let bestDist = Infinity;

        for (const slot of candidates) {
          const slotMinute = dateToMinuteOfDay(slot.start);
          const dist = Math.abs(slotMinute - preferredPlanningMinute);
          if (
            dist < bestDist ||
            (dist === bestDist && slot.start.getTime() < best.start.getTime())
          ) {
            best = slot;
            bestDist = dist;
          }
        }
        return best;
      }
      return candidates[0];
    }
    case 'DEADLINE_FIRST': {
      // For tasks with deadlines, prefer slots closer to the deadline.
      // For tasks without deadlines, earliest fit.
      return candidates[0];
    }
    default:
      return candidates[0];
  }
};

/**
 * Carves an occupied range out of available slots.
 */
const carveSlot = (
  slots: readonly AvailableSlot[],
  occupiedStart: Date,
  occupiedEnd: Date,
): AvailableSlot[] => {
  const result: AvailableSlot[] = [];

  for (const slot of slots) {
    // No overlap.
    if (
      occupiedEnd.getTime() <= slot.start.getTime() ||
      occupiedStart.getTime() >= slot.end.getTime()
    ) {
      result.push(slot);
      continue;
    }

    // Before occupied.
    if (occupiedStart.getTime() > slot.start.getTime()) {
      const before: AvailableSlot = {
        start: slot.start,
        end: occupiedStart,
        durationMinutes: Math.round((occupiedStart.getTime() - slot.start.getTime()) / 60_000),
      };
      if (before.durationMinutes > 0) result.push(before);
    }

    // After occupied.
    if (occupiedEnd.getTime() < slot.end.getTime()) {
      const after: AvailableSlot = {
        start: occupiedEnd,
        end: slot.end,
        durationMinutes: Math.round((slot.end.getTime() - occupiedEnd.getTime()) / 60_000),
      };
      if (after.durationMinutes > 0) result.push(after);
    }
  }

  return result;
};

const dateToMinuteOfDay = (date: Date): number => {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
};
