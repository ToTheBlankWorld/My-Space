import { FixedClock, type Clock } from '@space/time';

import { computeAvailability } from './availability';
import { detectAndResolveConflicts } from './conflicts';
import { enforceDeadlines } from './deadlines';
import { resolveDependencies } from './dependencies';
import { generateExplanations, generatePlanSummary } from './explanation';
import { reschedule } from './rescheduling';
import { scoreAndSortTasks } from './priority';
import { scheduleTasks } from './scheduling';
import type { PlanningInput, PlanningResult, ProposedAction } from './types';
import { normalizeTaskDurations, validatePlanningInput } from './validator';
import { enforceWorkload } from './workload';

/**
 * The deterministic Space Engine planner.
 *
 * This is the pure core entry point. It takes a PlanningInput snapshot
 * (loaded from the database by an application service) and produces a
 * PlanningResult with scheduled blocks, conflicts, explanations, and
 * proposed database actions.
 *
 * The same input ALWAYS produces the same output. No randomness, no
 * external calls, no side effects.
 *
 * Execution order (hard constraint pipeline):
 *   1. Validate input.
 *   2. Normalize task durations.
 *   3. Compute availability (working hours − calendar − existing items).
 *   4. Score and sort tasks (priority + deadline + strategy).
 *   5. Schedule tasks into available slots.
 *   6. Detect and resolve conflicts (overlaps).
 *   7. Enforce deadlines (backwards from due dates).
 *   8. Resolve dependencies (prerequisite ordering).
 *   9. Enforce workload (max focus, breaks, weekend).
 *  10. Reschedule (minimal-edit comparison with existing state).
 *  11. Generate explanations and reason codes.
 *  12. Produce summary and proposed actions.
 */
export const plan = (
  input: PlanningInput,
  clock: Clock = new FixedClock('2026-01-01T00:00:00.000Z'),
): PlanningResult => {
  const startTime = clock.nowMs();

  // 1. Validate.
  const validation = validatePlanningInput(input);
  if (!validation.valid) {
    return emptyResult(input, startTime, clock, 'Input validation failed.');
  }

  // 2. Normalize task durations.
  const normalizedTasks = normalizeTaskDurations(
    input.tasks,
    input.planningPreferences.defaultTaskDurationMinutes,
  );
  const normalizedInput = { ...input, tasks: normalizedTasks };

  // 3. Compute availability.
  const available = computeAvailability(normalizedInput);

  // 4. Score and sort tasks.
  const scored = scoreAndSortTasks(normalizedInput.tasks, normalizedInput);

  // 5. Schedule tasks into slots.
  const { scheduled, unscheduled } = scheduleTasks(scored, available, normalizedInput);

  // 6. Detect and resolve conflicts.
  const conflictResult = detectAndResolveConflicts(scheduled, normalizedInput);

  // 7. Enforce deadlines.
  const deadlineResult = enforceDeadlines(normalizedInput, conflictResult.resolved, unscheduled);

  // 8. Resolve dependencies.
  const dependencyResult = resolveDependencies(
    normalizedInput,
    deadlineResult.scheduled,
    deadlineResult.unscheduled,
  );

  // 9. Enforce workload.
  const workloadResult = enforceWorkload(
    normalizedInput,
    dependencyResult.scheduled,
    dependencyResult.unscheduled,
  );

  // 10. Reschedule (minimal edit comparison).
  const rescheduleResult = reschedule(
    normalizedInput,
    workloadResult.scheduled,
    workloadResult.unscheduled,
  );

  // 11. Generate explanations.
  const allConflicts = [
    ...conflictResult.conflicts,
    ...deadlineResult.conflicts,
    ...dependencyResult.conflicts,
  ];
  const explanations = generateExplanations(
    normalizedInput,
    rescheduleResult.scheduled,
    rescheduleResult.unscheduled,
    allConflicts,
  );

  // 12. Summary.
  const summary = generatePlanSummary(
    rescheduleResult.scheduled,
    rescheduleResult.unscheduled,
    allConflicts,
    input.date,
  );

  // 13. Collect all proposed actions.
  const proposedActions: ProposedAction[] = [
    ...conflictResult.conflicts.map((c) => ({
      actionType: 'CONFLICT_RESOLVED' as const,
      entityType: 'TASK' as const,
      entityId: c.itemIds[0] ?? '',
      reason: c.resolution,
      factors: { conflictType: c.type, itemIds: c.itemIds },
    })),
    ...deadlineResult.actions,
    ...dependencyResult.actions,
    ...workloadResult.actions,
    ...rescheduleResult.actions,
  ];

  const durationMs = clock.nowMs() - startTime;

  return {
    scheduledBlocks: rescheduleResult.scheduled,
    unscheduledTasks: rescheduleResult.unscheduled,
    conflicts: allConflicts,
    explanations,
    proposedActions,
    summary,
    planVersion: input.space.planVersion + 1,
    durationMs,
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emptyResult = (
  input: PlanningInput,
  startTimeMs: number,
  clock: Clock,
  errorMessage: string,
): PlanningResult => ({
  scheduledBlocks: [],
  unscheduledTasks: input.tasks.map((t) => ({
    taskId: t.id,
    reasonCode: 'HARD_NO_SLOTS' as const,
    message: errorMessage,
  })),
  conflicts: [],
  explanations: [],
  proposedActions: [],
  summary: `${input.date}: planning failed — ${errorMessage}`,
  planVersion: input.space.planVersion,
  durationMs: clock.nowMs() - startTimeMs,
});
