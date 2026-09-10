import type { DurationMinutes, SchedulingStrategy, TaskPriority } from '@space/types';

import type { PlanningInput, PlanningTask, ScoredTask } from './types';

/**
 * Priority scoring and ordering.
 *
 * Composite score = weighted sum of:
 *   - Priority level (CRITICAL=0, HIGH=1, NORMAL=2, LOW=3 → inverted for scoring)
 *   - Deadline proximity (hours until due, capped; lower = higher score)
 *   - Strategy weight (balancing or deadline-first emphasis)
 *
 * Tie-breaking order (all deterministic, no randomness):
 *   1. Higher composite score
 *   2. Earlier deadline (lower timestamp ms)
 *   3. Higher priority level (lower enum ordinal)
 *   4. Earlier created (lower timestamp ms — uses task id as stable proxy)
 *
 * Tasks with the same id always sort identically.
 */
export const scoreAndSortTasks = (
  tasks: readonly PlanningTask[],
  input: PlanningInput,
): ScoredTask[] => {
  const { schedulingStrategy, defaultTaskDurationMinutes } = input.planningPreferences;
  const now = input.date; // planning horizon anchor

  const scored: ScoredTask[] = tasks.map((task) => {
    const priorityScore = computePriorityScore(task.priority);
    const deadlineScore = computeDeadlineScore(task.dueAt, now);
    const strategyWeight = getStrategyWeight(schedulingStrategy, task);
    const durationWeight = getDurationWeight(task.estimatedMinutes ?? defaultTaskDurationMinutes);

    const score = priorityScore * 3 + deadlineScore * 2 + strategyWeight + durationWeight;

    return {
      task,
      score,
      deadlinePriority: task.dueAt ? task.dueAt.getTime() : Number.MAX_SAFE_INTEGER,
      priorityLevel: priorityOrdinal(task.priority),
      stableId: task.id,
    };
  });

  // Sort: highest score first, then deterministic tie-breaking.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.deadlinePriority !== b.deadlinePriority) return a.deadlinePriority - b.deadlinePriority;
    if (a.priorityLevel !== b.priorityLevel) return a.priorityLevel - b.priorityLevel;
    return a.stableId.localeCompare(b.stableId);
  });

  return scored;
};

/**
 * Priority level → numeric score (higher = more urgent).
 */
const computePriorityScore = (priority: TaskPriority): number => {
  switch (priority) {
    case 'CRITICAL':
      return 100;
    case 'HIGH':
      return 75;
    case 'NORMAL':
      return 50;
    case 'LOW':
      return 25;
  }
};

/**
 * Deadline proximity → numeric score (sooner deadline = higher score).
 *
 * Uses hours until deadline, capped at 168h (1 week). Tasks without
 * a deadline get a baseline score.
 */
const computeDeadlineScore = (dueAt: Date | null, dateAnchor: string): number => {
  if (!dueAt) return 20; // baseline: no deadline

  const anchorMs = calendarDateToMs(dateAnchor);
  const hoursUntilDue = Math.max(0, (dueAt.getTime() - anchorMs) / 3_600_000);

  // Closer deadlines score higher. Cap at 168h.
  return Math.max(0, 100 - Math.min(hoursUntilDue, 168));
};

/**
 * Strategy-specific weight adjustment.
 */
const getStrategyWeight = (strategy: SchedulingStrategy, task: PlanningTask): number => {
  switch (strategy) {
    case 'EARLIEST_FIT':
      // No weight: pure earliest-available placement.
      return 0;
    case 'DEADLINE_FIRST':
      // Amplify deadline proximity.
      return task.dueAt ? 30 : 0;
    case 'BALANCED':
      // Mild priority amplification.
      return task.priority === 'CRITICAL' ? 15 : task.priority === 'HIGH' ? 10 : 0;
  }
};

/**
 * Longer tasks get a mild penalty to encourage shorter tasks first
 * (more items placed per pass).
 */
const getDurationWeight = (estimatedMinutes: DurationMinutes): number => {
  const minutes = estimatedMinutes as number;
  if (minutes <= 15) return 10;
  if (minutes <= 30) return 8;
  if (minutes <= 60) return 5;
  return 2;
};

const priorityOrdinal = (priority: TaskPriority): number => {
  switch (priority) {
    case 'CRITICAL':
      return 0;
    case 'HIGH':
      return 1;
    case 'NORMAL':
      return 2;
    case 'LOW':
      return 3;
  }
};

const calendarDateToMs = (date: string): number => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day);
};
