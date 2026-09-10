export { plan } from './planner';

export type {
  PlanningInput,
  PlanningResult,
  PlanningTask,
  PlanningDependency,
  PlanningCalendarEvent,
  PlanningReminder,
  ExistingSpaceItem,
  PlanningWorkingHours,
  ScheduledBlock,
  UnscheduledTask,
  PlanningConflict,
  Explanation,
  ProposedAction,
  TimeBlock,
  ScoredTask,
  AvailableSlot,
  ReasonCode,
  ConflictType,
  EngineActionType,
} from './types';

export { REASON_CODES, CONFLICT_TYPES } from './types';

export {
  validatePlanningInput,
  normalizeTaskDurations,
  type ValidationResult,
  type Violation,
} from './validator';
export { computeAvailability, findSlotsForTask } from './availability';
export { scoreAndSortTasks } from './priority';
export { scheduleTasks } from './scheduling';
export { detectAndResolveConflicts } from './conflicts';
export { enforceDeadlines } from './deadlines';
export { resolveDependencies, hasCycle } from './dependencies';
export { enforceWorkload } from './workload';
export { reschedule } from './rescheduling';
export { generateExplanations, generatePlanSummary } from './explanation';
