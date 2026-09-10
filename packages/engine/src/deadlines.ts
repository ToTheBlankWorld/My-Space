import type {
  EngineAction,
  PlanningConflict,
  PlanningInput,
  ScheduledBlock,
  UnscheduledTask,
} from './types';

/**
 * Deadline enforcement.
 *
 * Ensures tasks with deadlines are scheduled no later than their due time.
 * For tasks whose deadlines fall within the planning horizon:
 *   - If the task is already scheduled before its deadline → pass.
 *   - If the task is scheduled after its deadline → flag as conflict.
 *   - If the task is unscheduled but deadline is reachable → enforce placement.
 *   - If the deadline is unreachable → flag as UNSCHEDULED_DEADLINE_UNREACHABLE.
 *
 * The engine works *backwards* from the deadline: it reserves time starting
 * from dueAt minus estimated duration, then checks whether the slot is free.
 *
 * Pure function: no side effects.
 */
export const enforceDeadlines = (
  input: PlanningInput,
  scheduled: ScheduledBlock[],
  unscheduled: UnscheduledTask[],
): {
  scheduled: ScheduledBlock[];
  unscheduled: UnscheduledTask[];
  conflicts: PlanningConflict[];
  actions: EngineAction[];
} => {
  const { defaultTaskDurationMinutes } = input.planningPreferences;
  const dayEnd = getDayEnd(input.date);
  const conflicts: PlanningConflict[] = [];
  const actions: EngineAction[] = [];
  const finalScheduled = [...scheduled];
  const finalUnscheduled = [...unscheduled];

  // Find tasks with deadlines in the planning horizon.
  const deadlineTasks = input.tasks.filter(
    (t) => t.dueAt !== null && t.dueAt.getTime() <= dayEnd.getTime(),
  );

  for (const task of deadlineTasks) {
    const dueAt = task.dueAt!;
    const duration = task.estimatedMinutes ?? defaultTaskDurationMinutes;
    const durationMs = (duration as number) * 60_000;

    // Check if already scheduled.
    const existing = finalScheduled.find((b) => b.itemId === task.id);

    if (existing) {
      if (existing.end.getTime() <= dueAt.getTime()) {
        // Scheduled before deadline — fine.
        actions.push({
          actionType: 'DEADLINE_ENFORCED',
          entityType: 'TASK',
          entityId: task.id,
          reason: `Task "${task.title}" scheduled before deadline.`,
          reasonCode: 'SCHEDULED_PLACED',
          factors: { dueAt: dueAt.toISOString(), scheduledEnd: existing.end.toISOString() },
        });
      } else {
        // Scheduled after deadline — conflict.
        conflicts.push({
          type: 'DEADLINE_UNREACHABLE',
          itemIds: [task.id],
          description: `Task "${task.title}" is scheduled to end after its deadline.`,
          resolution: `Deadline is after the planned end time.`,
          reasonCode: 'HARD_DEADLINE_CONFLICT',
        });

        actions.push({
          actionType: 'DEADLINE_ENFORCED',
          entityType: 'TASK',
          entityId: task.id,
          reason: `Deadline enforcement: task "${task.title}" has deadline ${dueAt.toISOString()} but is scheduled to end ${existing.end.toISOString()}.`,
          reasonCode: 'HARD_DEADLINE_CONFLICT',
          factors: { dueAt: dueAt.toISOString(), scheduledEnd: existing.end.toISOString() },
        });
      }
      continue;
    }

    // Task is unscheduled — check if deadline is reachable.
    if (dueAt.getTime() - durationMs < getDayStart(input.date).getTime()) {
      // Deadline unreachable — not enough time in the day.
      const idx = finalUnscheduled.findIndex((u) => u.taskId === task.id);
      if (idx >= 0) {
        finalUnscheduled[idx] = {
          ...finalUnscheduled[idx]!,
          reasonCode: 'UNSCHEDULED_DEADLINE_UNREACHABLE',
          message: `Deadline ${dueAt.toISOString()} is unreachable for "${task.title}" (${duration as number} minutes needed).`,
        };
      } else {
        finalUnscheduled.push({
          taskId: task.id,
          reasonCode: 'UNSCHEDULED_DEADLINE_UNREACHABLE',
          message: `Deadline ${dueAt.toISOString()} is unreachable for "${task.title}" (${duration as number} minutes needed).`,
        });
      }

      conflicts.push({
        type: 'DEADLINE_UNREACHABLE',
        itemIds: [task.id],
        description: `Deadline for "${task.title}" is unreachable within the day.`,
        resolution: `Not enough time before deadline.`,
        reasonCode: 'UNSCHEDULED_DEADLINE_UNREACHABLE',
      });
    }
  }

  return { scheduled: finalScheduled, unscheduled: finalUnscheduled, conflicts, actions };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getDayStart = (date: string): Date => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day, 0, 0));
};

const getDayEnd = (date: string): Date => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 1, 0, 0));
};
