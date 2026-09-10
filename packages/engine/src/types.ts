import type {
  AutonomyLevel,
  CalendarDate,
  CalendarEventStatus,
  DurationMinutes,
  SchedulingStrategy,
  SpaceItemKind,
  SpaceStatus,
  TaskPriority,
  TaskStatus,
  TimeZone,
  Weekday,
} from '@space/types';

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

/**
 * Stable, machine-readable reason codes for every decision the engine makes.
 *
 * Each code names exactly one rule. A code is never ambiguous: the same code
 * always means the same decision, regardless of which inputs triggered it.
 */
export const REASON_CODES = [
  'HARD_WORKING_HOURS',
  'HARD_CALENDAR_BLOCK',
  'HARD_DEPENDENCY_BLOCKED',
  'HARD_DEADLINE_CONFLICT',
  'HARD_NO_SLOTS',
  'HARD_MAX_FOCUS_EXCEEDED',
  'HARD_WEEKEND_BLOCKED',
  'HARD_AUTONOMY_SUGGEST_ONLY',
  'HARD_AUTONOMY_ASK_REQUIRED',

  'SOFT_PRIORITY_ORDER',
  'SOFT_DEADLINE_PROXIMITY',
  'SOFT_EARLIEST_START',
  'SOFT_STRATEGY_BALANCED',
  'SOFT_STRATEGY_EARLIEST_FIT',
  'SOFT_STRATEGY_DEADLINE_FIRST',
  'SOFT_BUFFER_INSERTED',
  'SOFT_BREAK_REQUIRED',
  'SOFT_PREFERRED_PLANNING_TIME',

  'CONFLICT_OVERLAP',
  'CONFLICT_RESOLVED_BY_PRIORITY',
  'CONFLICT_RESOLVED_BY_DELEGATION',
  'CONFLICT_RESCHEDULED',

  'SCHEDULED_PLACED',
  'SCHEDULED_CALENDAR_ANCHORED',
  'SCHEDULED_REMAINDER',
  'UNSCHEDULED_NO_SLOTS',
  'UNSCHEDULED_DEPENDENCY_CHAIN',
  'UNSCHEDULED_DEADLINE_UNREACHABLE',
  'UNSCHEDULED_WORKLOAD_EXCEEDED',
  'UNSCHEDULED_AUTONOMY_RESTRICTED',

  'RESCHEDULED_CARRY_FORWARD',
  'RESCHEDULED_CONFLICT_REPAIR',
  'RESCHEDULED_MINIMAL_EDIT',
  'RESCHEDULED_UNCHANGED',

  'EXPLANATION_PRIORITY',
  'EXPLANATION_DEADLINE',
  'EXPLANATION_DEPENDENCY',
  'EXPLANATION_CALENDAR',
  'EXPLANATION_WORKLOAD',
  'EXPLANATION_AUTONOMY',
  'EXPLANATION_STRATEGY',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

// ---------------------------------------------------------------------------
// Conflict types
// ---------------------------------------------------------------------------

export const CONFLICT_TYPES = [
  'TASK_CALENDAR_OVERLAP',
  'TASK_TASK_OVERLAP',
  'TASK_OUTSIDE_WORKING_HOURS',
  'DEADLINE_UNREACHABLE',
  'DEPENDENCY_CYCLE',
  'DEPENDENCY_MISSING_PREREQUISITE',
] as const;

export type ConflictType = (typeof CONFLICT_TYPES)[number];

// ---------------------------------------------------------------------------
// Agent action types (subset used by engine)
// ---------------------------------------------------------------------------

export type EngineActionType =
  | 'SPACE_PLANNED'
  | 'TASK_SCHEDULED'
  | 'TASK_RESCHEDULED'
  | 'TASK_DEFERRED'
  | 'CONFLICT_RESOLVED'
  | 'WORKLOAD_BALANCED'
  | 'DEADLINE_ENFORCED';

// ---------------------------------------------------------------------------
// Planning input snapshot
// ---------------------------------------------------------------------------

/** A task the engine may schedule. */
export interface PlanningTask {
  id: string;
  title: string;
  priority: TaskPriority;
  status: TaskStatus;
  estimatedMinutes: DurationMinutes | null;
  dueAt: Date | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  goalId: string | null;
}

/** A task dependency edge: `taskId` depends on `dependsOnId`. */
export interface PlanningDependency {
  taskId: string;
  dependsOnId: string;
}

/** An external calendar event occupying time. */
export interface PlanningCalendarEvent {
  id: string;
  startAt: Date;
  endAt: Date;
  isAllDay: boolean;
  status: CalendarEventStatus;
  title: string;
}

/** A reminder due during the target day. */
export interface PlanningReminder {
  id: string;
  remindAt: Date;
  status: 'PENDING' | 'COMPLETED' | 'CANCELLED' | 'MISSED';
  title: string;
}

/** Current SpaceItem state, for rescheduling awareness. */
export interface ExistingSpaceItem {
  id: string;
  kind: SpaceItemKind;
  position: number;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  taskId: string | null;
  reminderId: string | null;
  calendarEventId: string | null;
}

/** One block of availability for a weekday. */
export interface PlanningWorkingHours {
  weekday: Weekday;
  startMinute: number;
  endMinute: number;
}

/** The complete input snapshot for one planning pass. */
export interface PlanningInput {
  userId: string;
  date: CalendarDate;
  timeZone: TimeZone;

  planningPreferences: {
    defaultTaskDurationMinutes: DurationMinutes;
    preferredPlanningMinute: number | null;
    schedulingStrategy: SchedulingStrategy;
    autonomyLevel: AutonomyLevel;
    maxDailyFocusMinutes: DurationMinutes;
    minBreakMinutes: DurationMinutes;
    bufferMinutes: DurationMinutes;
    allowWeekendScheduling: boolean;
  };

  workingHours: PlanningWorkingHours[];
  tasks: PlanningTask[];
  calendarEvents: PlanningCalendarEvent[];
  reminders: PlanningReminder[];
  dependencies: PlanningDependency[];
  existingItems: ExistingSpaceItem[];

  space: {
    id: string;
    planVersion: number;
    status: SpaceStatus;
  };
}

// ---------------------------------------------------------------------------
// Planning output
// ---------------------------------------------------------------------------

/** A block of time assigned to one item. */
export interface ScheduledBlock {
  kind: SpaceItemKind;
  itemId: string;
  start: Date;
  end: Date;
  position: number;
  reasonCode: ReasonCode;
}

/** A task the engine could not place. */
export interface UnscheduledTask {
  taskId: string;
  reasonCode: ReasonCode;
  message: string;
}

/** An overlap detected between two items. */
export interface PlanningConflict {
  type: ConflictType;
  itemIds: string[];
  description: string;
  resolution: string;
  reasonCode: ReasonCode;
}

/** A human-readable explanation for one decision. */
export interface Explanation {
  itemId: string;
  kind: SpaceItemKind;
  reasonCode: ReasonCode;
  message: string;
  factors: Record<string, unknown>;
}

/** A proposed database action (AgentAction row). */
export interface ProposedAction {
  actionType: EngineActionType;
  entityType: 'TASK' | 'SPACE' | 'CALENDAR_EVENT' | 'REMINDER' | 'USER';
  entityId: string;
  reason: string;
  factors: Record<string, unknown>;
  previousState?: Record<string, unknown>;
  resultingState?: Record<string, unknown>;
}

/**
 * The weaker shape sub-modules emit before the planner annotates them.
 *
 * Each engine module returns a list of these; the planner narrows them to
 * {@link ProposedAction} when it assembles the result.
 */
export interface EngineAction {
  actionType: EngineActionType;
  entityType: 'TASK' | 'SPACE' | 'CALENDAR_EVENT' | 'REMINDER' | 'USER';
  entityId: string;
  reason: string;
  reasonCode: ReasonCode;
  factors: Record<string, unknown>;
  previousState?: Record<string, unknown>;
  resultingState?: Record<string, unknown>;
}

/** The complete result of one planning pass. */
export interface PlanningResult {
  scheduledBlocks: ScheduledBlock[];
  unscheduledTasks: UnscheduledTask[];
  conflicts: PlanningConflict[];
  explanations: Explanation[];
  proposedActions: ProposedAction[];
  summary: string;
  planVersion: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Time block (internal, for availability computation)
// ---------------------------------------------------------------------------

/** An immutable half-open time interval. */
export interface TimeBlock {
  start: Date;
  end: Date;
  /** When true, this block is occupied and cannot be scheduled into. */
  immutable: boolean;
  /** The item occupying this block, if any. */
  ownerId?: string;
  ownerKind?: SpaceItemKind;
}

/** A scored task with composite priority for scheduling. */
export interface ScoredTask {
  task: PlanningTask;
  score: number;
  /** Primary sort key: deadline proximity (lower = sooner = higher priority). */
  deadlinePriority: number;
  /** Secondary sort key: task priority level (lower = higher priority). */
  priorityLevel: number;
  /** Tertiary sort key: stable task id for deterministic tie-breaking. */
  stableId: string;
}

/** An available slot where a task could be placed. */
export interface AvailableSlot {
  start: Date;
  end: Date;
  durationMinutes: number;
}
