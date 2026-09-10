import type {
  Explanation,
  PlanningConflict,
  PlanningInput,
  PlanningTask,
  ScheduledBlock,
  UnscheduledTask,
} from './types';

/**
 * Explanation generator.
 *
 * Produces a human-readable explanation for every decision the engine made,
 * keyed by reason code. Every explanation traces back to exactly one rule.
 *
 * Explanations are grouped by item (task, calendar event, reminder) so the UI
 * can show "why this task is at 10:00" in a single tooltip.
 *
 * Pure function: no side effects.
 */
export const generateExplanations = (
  input: PlanningInput,
  scheduled: readonly ScheduledBlock[],
  unscheduled: readonly UnscheduledTask[],
  conflicts: readonly PlanningConflict[],
): Explanation[] => {
  const explanations: Explanation[] = [];

  // Explanations for scheduled items.
  for (const block of scheduled) {
    const task = block.kind === 'TASK' ? input.tasks.find((t) => t.id === block.itemId) : undefined;

    explanations.push({
      itemId: block.itemId,
      kind: block.kind,
      reasonCode: block.reasonCode,
      message: formatScheduledMessage(block, task, input),
      factors: {
        start: block.start.toISOString(),
        end: block.end.toISOString(),
        reasonCode: block.reasonCode,
        ...(task ? { priority: task.priority, estimatedMinutes: task.estimatedMinutes } : {}),
      },
    });
  }

  // Explanations for unscheduled tasks.
  for (const item of unscheduled) {
    const task = input.tasks.find((t) => t.id === item.taskId);

    explanations.push({
      itemId: item.taskId,
      kind: 'TASK',
      reasonCode: item.reasonCode,
      message: item.message,
      factors: {
        reasonCode: item.reasonCode,
        ...(task ? { priority: task.priority, dueAt: task.dueAt?.toISOString() } : {}),
      },
    });
  }

  // Explanations for conflicts.
  for (const conflict of conflicts) {
    for (const itemId of conflict.itemIds) {
      explanations.push({
        itemId,
        kind: 'TASK',
        reasonCode: conflict.reasonCode,
        message: `${conflict.description} ${conflict.resolution}`,
        factors: {
          conflictType: conflict.type,
          allItemIds: conflict.itemIds,
        },
      });
    }
  }

  return explanations;
};

/**
 * Generates a one-line summary of the plan.
 */
export const generatePlanSummary = (
  scheduled: readonly ScheduledBlock[],
  unscheduled: readonly UnscheduledTask[],
  conflicts: readonly PlanningConflict[],
  date: string,
): string => {
  const taskCount = scheduled.filter((b) => b.kind === 'TASK').length;
  const unscheduledCount = unscheduled.length;
  const conflictCount = conflicts.length;

  const parts: string[] = [];
  parts.push(`${date}: ${taskCount} task${taskCount === 1 ? '' : 's'} planned`);

  if (unscheduledCount > 0) {
    parts.push(`${unscheduledCount} deferred`);
  }
  if (conflictCount > 0) {
    parts.push(`${conflictCount} conflict${conflictCount === 1 ? '' : 's'} resolved`);
  }

  return parts.join(', ') + '.';
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const formatScheduledMessage = (
  block: ScheduledBlock,
  task: PlanningTask | undefined,
  _input: PlanningInput,
): string => {
  const start = formatTime(block.start);
  const end = formatTime(block.end);

  if (block.kind === 'TASK' && task) {
    switch (block.reasonCode) {
      case 'SCHEDULED_PLACED':
        return `Scheduled from ${start} to ${end} (priority: ${task.priority}).`;
      case 'SCHEDULED_CALENDAR_ANCHORED':
        return `Placed at ${start} to align with calendar context.`;
      case 'SCHEDULED_REMAINDER':
        return `Placed in remaining time slot ${start}–${end}.`;
      default:
        return `Placed from ${start} to ${end}.`;
    }
  }

  return `Scheduled from ${start} to ${end}.`;
};

const formatTime = (date: Date): string => {
  const h = String(date.getUTCHours()).padStart(2, '0');
  const m = String(date.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
};
