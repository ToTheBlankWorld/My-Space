/**
 * The domain vocabulary of Space.
 *
 * These constants are the single source of truth for every closed set of values
 * in the system. The Prisma schema mirrors them as native PostgreSQL enums, and
 * `@space/validation` builds its schemas from them, so a value can never be
 * accepted by validation but rejected by the database (a drift test in
 * `@space/database` asserts the two stay identical).
 *
 * Display labels are deliberately absent: they belong to the presentation layer
 * and change independently of the data.
 */

/** Lifecycle of a user account. */
export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DELETED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * How much the deterministic Space Engine may change without confirmation.
 *
 * `SUGGEST_ONLY` proposes and never writes; `ASK_BEFORE_CHANGING` writes only
 * after the user accepts; `AUTOMATICALLY_MANAGE` applies its rules and reports
 * what it did through the audit trail. Stage 3 stores the preference; no
 * autonomous behaviour exists yet.
 */
export const AUTONOMY_LEVELS = [
  'SUGGEST_ONLY',
  'ASK_BEFORE_CHANGING',
  'AUTOMATICALLY_MANAGE',
] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** Rule set the Scheduling Engine applies when placing work. */
export const SCHEDULING_STRATEGIES = ['EARLIEST_FIT', 'BALANCED', 'DEADLINE_FIRST'] as const;
export type SchedulingStrategy = (typeof SCHEDULING_STRATEGIES)[number];

/** ISO-8601 weekday numbering (Monday = 1) is used everywhere. */
export const WEEKDAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Lifecycle of a Space (one user's plan for one calendar date). */
export const SPACE_STATUSES = ['DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED'] as const;
export type SpaceStatus = (typeof SPACE_STATUSES)[number];

/** Which concrete entity a Space item points at. */
export const SPACE_ITEM_KINDS = ['TASK', 'REMINDER', 'CALENDAR_EVENT'] as const;
export type SpaceItemKind = (typeof SPACE_ITEM_KINDS)[number];

export const TASK_PRIORITIES = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = [
  'INBOX',
  'PLANNED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'MISSED',
  'RESCHEDULED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Legal task status transitions.
 *
 * The table lives beside the enum because it is part of the contract, not an
 * implementation detail: the API, the worker and the future Rescheduling Engine
 * must all agree on which moves are possible. `COMPLETED` and `CANCELLED` are
 * terminal; `MISSED` and `RESCHEDULED` are recoverable, because a plan that
 * slipped is re-planned rather than discarded.
 */
export const TASK_STATUS_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> =
  Object.freeze({
    INBOX: ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
    PLANNED: ['INBOX', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'MISSED', 'RESCHEDULED'],
    IN_PROGRESS: ['PLANNED', 'COMPLETED', 'CANCELLED', 'MISSED', 'RESCHEDULED'],
    COMPLETED: [],
    CANCELLED: [],
    MISSED: ['PLANNED', 'RESCHEDULED', 'CANCELLED'],
    RESCHEDULED: ['PLANNED', 'IN_PROGRESS', 'CANCELLED', 'MISSED'],
  });

/** True when `to` is a legal next status for a task currently in `from`. */
export const canTransitionTask = (from: TaskStatus, to: TaskStatus): boolean =>
  TASK_STATUS_TRANSITIONS[from].includes(to);

/** True when no further transition is possible. */
export const isTerminalTaskStatus = (status: TaskStatus): boolean =>
  TASK_STATUS_TRANSITIONS[status].length === 0;

export const REMINDER_STATUSES = ['PENDING', 'COMPLETED', 'CANCELLED', 'MISSED'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

/**
 * Progress of an outbound delivery attempt.
 *
 * Shared by reminders and notifications: both are "something we owe the user at
 * a point in time", and keeping one vocabulary means one dashboard and one
 * retry policy later.
 */
export const DELIVERY_STATES = ['PENDING', 'QUEUED', 'SENT', 'FAILED', 'SKIPPED'] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const RECURRENCE_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export const GOAL_STATUSES = ['ACTIVE', 'ACHIEVED', 'PAUSED', 'ABANDONED'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const CALENDAR_PROVIDERS = ['GOOGLE'] as const;
export type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number];

export const CONNECTION_STATUSES = ['CONNECTED', 'DISCONNECTED', 'ERROR'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CALENDAR_EVENT_STATUSES = ['CONFIRMED', 'TENTATIVE', 'CANCELLED'] as const;
export type CalendarEventStatus = (typeof CALENDAR_EVENT_STATUSES)[number];

/**
 * Which side of a two-way synchronisation still owes work.
 *
 * Modelled now, exercised in Stage 4: without it, a later migration would have
 * to backfill state for every row already imported.
 */
export const SYNC_STATES = [
  'SYNCED',
  'PENDING_PUSH',
  'PENDING_PULL',
  'CONFLICT',
  'FAILED',
] as const;
export type SyncState = (typeof SYNC_STATES)[number];

export const NOTIFICATION_TYPES = [
  'DAILY_PLAN',
  'TASK_REMINDER',
  'DEADLINE_WARNING',
  'SCHEDULE_CHANGE',
  'SYSTEM',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** How loudly a notification may interrupt. `SILENT` is recorded but never pushed. */
export const NOTIFICATION_PRIORITIES = ['CRITICAL', 'IMPORTANT', 'NORMAL', 'SILENT'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

export const EMAIL_STATUSES = ['QUEUED', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/**
 * Decisions the deterministic Space Engine records in its audit trail.
 *
 * Every value names a concrete, rule-driven operation. Nothing here records
 * inference or generated content: the engine explains itself by naming the rule
 * that fired and the factors it read.
 */
export const AGENT_ACTION_TYPES = [
  'SPACE_PLANNED',
  'TASK_SCHEDULED',
  'TASK_RESCHEDULED',
  'TASK_DEFERRED',
  'CONFLICT_RESOLVED',
  'WORKLOAD_BALANCED',
  'DEADLINE_ENFORCED',
  'CALENDAR_RECONCILED',
  'NOTIFICATION_DISPATCHED',
] as const;
export type AgentActionType = (typeof AGENT_ACTION_TYPES)[number];

export const AGENT_ACTION_OUTCOMES = ['SUCCEEDED', 'FAILED', 'SKIPPED'] as const;
export type AgentActionOutcome = (typeof AGENT_ACTION_OUTCOMES)[number];

/** Domain events appended to the immutable event log. */
export const EVENT_TYPES = [
  'SPACE_CREATED',
  'SPACE_UPDATED',
  'SPACE_OPTIMIZED',
  'TASK_CREATED',
  'TASK_UPDATED',
  'TASK_COMPLETED',
  'TASK_MISSED',
  'TASK_RESCHEDULED',
  'REMINDER_CREATED',
  'REMINDER_TRIGGERED',
  'DEADLINE_APPROACHING',
  'GOAL_CREATED',
  'GOAL_ACHIEVED',
  'CALENDAR_CHANGED',
  'NOTIFICATION_SENT',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Aggregates an event can be attached to. */
export const AGGREGATE_TYPES = [
  'USER',
  'SPACE',
  'TASK',
  'REMINDER',
  'GOAL',
  'CALENDAR_EVENT',
  'NOTIFICATION',
] as const;
export type AggregateType = (typeof AGGREGATE_TYPES)[number];
