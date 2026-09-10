import type { DurationMinutes } from '@space/types';

import type { PlanningInput, PlanningTask } from './types';

/**
 * Input validation for the planning engine.
 *
 * Validates the PlanningInput snapshot for structural correctness and
 * business rule compliance. Returns a list of violations; an empty list
 * means the input is valid.
 *
 * Pure function: no side effects.
 */
export interface ValidationResult {
  valid: boolean;
  violations: Violation[];
}

export interface Violation {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export const validatePlanningInput = (input: PlanningInput): ValidationResult => {
  const violations: Violation[] = [];

  // Basic field checks.
  if (!input.userId)
    violations.push({ field: 'userId', message: 'userId is required', severity: 'error' });
  if (!input.date)
    violations.push({ field: 'date', message: 'date is required', severity: 'error' });
  if (!input.timeZone)
    violations.push({ field: 'timeZone', message: 'timeZone is required', severity: 'error' });

  // Space.
  if (!input.space?.id)
    violations.push({ field: 'space.id', message: 'space.id is required', severity: 'error' });
  if (input.space.planVersion < 0)
    violations.push({
      field: 'space.planVersion',
      message: 'planVersion must be non-negative',
      severity: 'error',
    });

  // Planning preferences.
  const prefs = input.planningPreferences;
  if ((prefs.defaultTaskDurationMinutes as number) <= 0) {
    violations.push({
      field: 'planningPreferences.defaultTaskDurationMinutes',
      message: 'must be positive',
      severity: 'error',
    });
  }
  if ((prefs.maxDailyFocusMinutes as number) <= 0) {
    violations.push({
      field: 'planningPreferences.maxDailyFocusMinutes',
      message: 'must be positive',
      severity: 'error',
    });
  }
  if ((prefs.minBreakMinutes as number) < 0) {
    violations.push({
      field: 'planningPreferences.minBreakMinutes',
      message: 'must be non-negative',
      severity: 'error',
    });
  }
  if ((prefs.bufferMinutes as number) < 0) {
    violations.push({
      field: 'planningPreferences.bufferMinutes',
      message: 'must be non-negative',
      severity: 'error',
    });
  }

  // Tasks.
  for (const task of input.tasks) {
    if (!task.id)
      violations.push({ field: 'task.id', message: 'task id is required', severity: 'error' });
    if (!task.title)
      violations.push({
        field: `task[${task.id}].title`,
        message: 'title is required',
        severity: 'warning',
      });
    if (task.estimatedMinutes !== null && (task.estimatedMinutes as number) <= 0) {
      violations.push({
        field: `task[${task.id}].estimatedMinutes`,
        message: 'must be positive when set',
        severity: 'error',
      });
    }
    if (task.dueAt && task.scheduledEnd && task.dueAt.getTime() < task.scheduledEnd.getTime()) {
      violations.push({
        field: `task[${task.id}].dueAt`,
        message: 'deadline is before scheduled end',
        severity: 'warning',
      });
    }
  }

  // Dependencies: check for self-dependency.
  for (const dep of input.dependencies) {
    if (dep.taskId === dep.dependsOnId) {
      violations.push({
        field: 'dependency',
        message: `self-dependency on ${dep.taskId}`,
        severity: 'error',
      });
    }
  }

  // Working hours: check for valid ranges.
  for (const wh of input.workingHours) {
    if (wh.startMinute >= wh.endMinute) {
      violations.push({
        field: `workingHours[${wh.weekday}]`,
        message: `startMinute (${wh.startMinute}) must be before endMinute (${wh.endMinute})`,
        severity: 'error',
      });
    }
  }

  return {
    valid: violations.filter((v) => v.severity === 'error').length === 0,
    violations,
  };
};

/**
 * Normalizes task durations: fills in defaults for null estimatedMinutes.
 */
export const normalizeTaskDurations = (
  tasks: readonly PlanningTask[],
  defaultDuration: DurationMinutes,
): PlanningTask[] =>
  tasks.map((task) => ({
    ...task,
    estimatedMinutes: task.estimatedMinutes ?? defaultDuration,
  }));
