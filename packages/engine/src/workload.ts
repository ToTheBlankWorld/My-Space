import type { EngineAction, PlanningInput, ScheduledBlock, UnscheduledTask } from './types';

/**
 * Workload enforcement.
 *
 * Ensures the day stays achievable by enforcing:
 *   - Maximum daily focus minutes (total scheduled task time cap).
 *   - Minimum break between consecutive task blocks.
 *   - Weekend scheduling restrictions.
 *
 * Tasks that exceed the daily focus budget are removed from the schedule
 * and returned as unscheduled with the appropriate reason code.
 *
 * Pure function: no side effects.
 */
export const enforceWorkload = (
  input: PlanningInput,
  scheduled: ScheduledBlock[],
  unscheduled: UnscheduledTask[],
): {
  scheduled: ScheduledBlock[];
  unscheduled: UnscheduledTask[];
  actions: EngineAction[];
} => {
  const { maxDailyFocusMinutes, minBreakMinutes, allowWeekendScheduling } =
    input.planningPreferences;

  const actions: EngineAction[] = [];
  let finalScheduled = [...scheduled];
  const finalUnscheduled = [...unscheduled];

  // 1. Weekend check.
  if (!allowWeekendScheduling && isWeekend(input.date)) {
    const taskBlocks = finalScheduled.filter((b) => b.kind === 'TASK');

    for (const block of taskBlocks) {
      finalUnscheduled.push({
        taskId: block.itemId,
        reasonCode: 'UNSCHEDULED_AUTONOMY_RESTRICTED',
        message: `Weekend scheduling is disabled.`,
      });

      actions.push({
        actionType: 'TASK_DEFERRED',
        entityType: 'TASK',
        entityId: block.itemId,
        reason: 'Weekend scheduling is disabled by user preference.',
        reasonCode: 'HARD_WEEKEND_BLOCKED',
        factors: { date: input.date, allowWeekendScheduling },
      });
    }

    finalScheduled = finalScheduled.filter((b) => b.kind !== 'TASK');
  }

  // 2. Maximum daily focus minutes.
  let totalFocusMinutes = 0;
  const exceedingBlocks: ScheduledBlock[] = [];

  for (const block of finalScheduled) {
    if (block.kind !== 'TASK') continue;

    const blockMinutes = Math.round((block.end.getTime() - block.start.getTime()) / 60_000);
    totalFocusMinutes += blockMinutes;

    if (totalFocusMinutes > (maxDailyFocusMinutes as number)) {
      exceedingBlocks.push(block);
    }
  }

  for (const block of exceedingBlocks) {
    finalUnscheduled.push({
      taskId: block.itemId,
      reasonCode: 'UNSCHEDULED_WORKLOAD_EXCEEDED',
      message: `Exceeds maximum daily focus time of ${maxDailyFocusMinutes as number} minutes.`,
    });

    const task = input.tasks.find((t) => t.id === block.itemId);
    actions.push({
      actionType: 'WORKLOAD_BALANCED',
      entityType: 'TASK',
      entityId: block.itemId,
      reason: `Task "${task?.title ?? block.itemId}" exceeds daily focus budget.`,
      reasonCode: 'HARD_MAX_FOCUS_EXCEEDED',
      factors: {
        maxDailyFocusMinutes,
        totalScheduled: totalFocusMinutes,
        taskMinutes: Math.round((block.end.getTime() - block.start.getTime()) / 60_000),
      },
    });

    totalFocusMinutes -= Math.round((block.end.getTime() - block.start.getTime()) / 60_000);
  }

  finalScheduled = finalScheduled.filter((b) => !exceedingBlocks.includes(b));

  // 3. Minimum break enforcement (informational — marks violations but doesn't remove).
  const taskBlocks = finalScheduled
    .filter((b) => b.kind === 'TASK')
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  for (let i = 1; i < taskBlocks.length; i += 1) {
    const prev = taskBlocks[i - 1]!;
    const curr = taskBlocks[i]!;
    const breakMinutes = Math.round((curr.start.getTime() - prev.end.getTime()) / 60_000);

    if (breakMinutes < (minBreakMinutes as number) && breakMinutes >= 0) {
      actions.push({
        actionType: 'WORKLOAD_BALANCED',
        entityType: 'TASK',
        entityId: curr.itemId,
        reason: `Break between tasks is ${breakMinutes} minutes (minimum: ${minBreakMinutes as number}).`,
        reasonCode: 'SOFT_BREAK_REQUIRED',
        factors: {
          previousTaskId: prev.itemId,
          breakMinutes,
          minBreakMinutes,
        },
      });
    }
  }

  return { scheduled: finalScheduled, unscheduled: finalUnscheduled, actions };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isWeekend = (date: string): boolean => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = d.getUTCDay();
  return dayOfWeek === 0 || dayOfWeek === 6;
};
