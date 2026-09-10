import type { ReasonCode } from '@space/engine';
import type { AutonomyLevel, CalendarDate, EventType, SpaceItemKind, TimeZone } from '@space/types';

/**
 * Shared vocabulary of the autonomous space loop.
 *
 * The loop is strictly deterministic: for every signal it reads it produces one
 * decision (a classification, a diff entry, a replan request). No decision here
 * depends on a clock, on randomness, or on a model — every rule is a pure
 * function of facts, which is what makes a retried review identical to the
 * first one.
 */

// ---------------------------------------------------------------------------
// Change classification
// ---------------------------------------------------------------------------

/**
 * How loudly a detected change demands the loop respond.
 *
 * The spectrum is monotone: NO_REPLAN < REVIEW_ONLY < REPLAN_REQUIRED <
 * URGENT_REPLAN. An event maps to exactly one bucket; the review then decides
 * whether enqueueing a replan is worth it for the affected day.
 */
export const CHANGE_CLASSIFICATIONS = [
  'NO_REPLAN',
  'REVIEW_ONLY',
  'REPLAN_REQUIRED',
  'URGENT_REPLAN',
] as const;
export type ChangeClassification = (typeof CHANGE_CLASSIFICATIONS)[number];

/** Stable, machine-readable name of the rule that produced a classification. */
export const CHANGE_REASON_CODES = [
  'CALENDAR_CHANGED',
  'DEADLINE_IMPENDING',
  'DEADLINE_IMPOSSIBLE',
  'DEADLINE_ELAPSED',
  'TASK_CHANGED',
  'TASK_COMPLETED',
  'TASK_MISSED_ELAPSED',
  'TASK_OVERDUE',
  'PLANNING_COMPLETED',
  'TOMORROW_UNPLANNED',
  'REVIEW_ONLY',
  'NO_CHANGE',
] as const;
export type ChangeReasonCode = (typeof CHANGE_REASON_CODES)[number];

export interface ClassifiedChange {
  eventType: string;
  classification: ChangeClassification;
  reasonCode: ChangeReasonCode;
  /** One human-readable sentence naming the rule that fired. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Plan diff
// ---------------------------------------------------------------------------

/**
 * What one replan did to an already-planned day.
 *
 * COMPLETED is a deliberate positive case of REMOVED: work that left the day
 * because the user finished it, not because the engine dropped it.
 */
export const PLAN_DIFF_TYPES = [
  'UNCHANGED',
  'ADDED',
  'MOVED',
  'REMOVED',
  'UNSCHEDULED',
  'COMPLETED',
] as const;
export type PlanDiffType = (typeof PLAN_DIFF_TYPES)[number];

/** Stable reason codes for diff entries; the diff names its own rule. */
export const PLAN_DIFF_REASON_CODES = [
  'PLAN_DIFF_ADDED',
  'PLAN_DIFF_MOVED',
  'PLAN_DIFF_UNCHANGED',
  'PLAN_DIFF_REMOVED',
  'PLAN_DIFF_UNSCHEDULED',
  'PLAN_DIFF_COMPLETED',
] as const;
export type PlanDiffReasonCode = (typeof PLAN_DIFF_REASON_CODES)[number];

export interface PlanDiffEntry {
  type: PlanDiffType;
  itemId: string;
  kind: SpaceItemKind;
  reasonCode: PlanDiffReasonCode;
  /** The engine's own reason when the entry follows a placed or unplaced block. */
  engineReasonCode?: ReasonCode;
  message: string;
  previous?: { start: number; end: number | null } | null;
  next?: { start: number; end: number | null } | null;
}

export interface PlanDiff {
  planVersion: number;
  entries: PlanDiffEntry[];
  counts: Record<PlanDiffType, number>;
  /** True when the replan actually changed the day. */
  hasMeaningfulChange: boolean;
}

// ---------------------------------------------------------------------------
// Review phases
// ---------------------------------------------------------------------------

/** A scheduled block that elapsed without the task being completed. */
export interface MissedTaskCase {
  taskId: string;
  title: string;
  userId: string;
  spaceId: string | null;
  /** The calendar date the block fell on, in the user's zone. */
  missedDate: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  autonomyLevel: string;
}

/** An open task whose deadline is at risk or already unmeetable. */
export interface DeadlineCase {
  taskId: string;
  title: string;
  userId: string;
  spaceId: string | null;
  dueAt: Date;
  dueDate: string;
  scheduledEnd: Date | null;
  classification: ChangeClassification;
  reasonCode: ChangeReasonCode;
}

/** Which phase asked for a replan, for the audit trail and the coalescing guard. */
export interface ReplanRequest {
  userId: string;
  spaceId: string;
  date: string;
  planVersion: number;
  classification: ChangeClassification;
  reasonCode: ChangeReasonCode;
  rationale: string;
}

/** Bounded summary of one autonomous review pass; logged and returned. */
export interface ReviewSummary {
  reviewedAt: Date;
  missedDetected: number;
  missedTransitioned: number;
  missedNotified: number;
  deadlineCases: number;
  deadlineEvents: number;
  deadlineNotified: number;
  calendarChanges: number;
  calendarReplans: number;
  tomorrowPlans: number;
  replansEnqueued: number;
  replansCoalesced: number;
  // Stage 9 — trigger graph pipeline metrics
  triggerEventsScanned: number;
  triggerReplansQueued: number;
  triggerImpactSkipped: number;
  triggerFeedbackSuppressed: number;
  triggerAutonomyDenied: number;
  notificationsBatched: number;
}

// ---------------------------------------------------------------------------
// Stage 9 — Trigger graph
// ---------------------------------------------------------------------------

/**
 * How an event's affected space(s) are resolved.
 *
 * `EVENT_DATE` — the event's aggregate is a Task/Reminder on a specific Space date.
 * `CALENDAR_SYNC` — the event came from a calendar sync; affected dates are
 *   derived from the calendar events' start times in the user's timezone.
 * `USER_SCOPE` — the event affects all of the user's active spaces (e.g.
 *   working-hours change). Currently unused but reserved.
 * `DEADLINE_SCAN` — the review phase scans for at-risk deadlines; the affected
 *   space is determined by the task's `spaceId`.
 */
export type SpaceResolutionStrategy =
  'EVENT_DATE' | 'CALENDAR_SYNC' | 'USER_SCOPE' | 'DEADLINE_SCAN';

/** Which signals an event carries for impact analysis. */
export type ImpactSignalKind =
  | 'SCHEDULE_COLLISION'
  | 'LOST_AVAILABILITY'
  | 'DEADLINE_RISK'
  | 'DEPENDENCY_BREAK'
  | 'TASK_LATENESS'
  | 'CALENDAR_DRIFT'
  | 'WORKLOAD_IMBALANCE'
  | 'NEWLY_AVAILABLE'
  | 'NEWLY_UNAVAILABLE'
  | 'COMMITMENT_CONFLICT';

/** A single impact signal detected for a Space. */
export interface ImpactSignal {
  kind: ImpactSignalKind;
  /** The task or event causing the signal, if applicable. */
  entityId?: string;
  /** Human-readable description of the impact. */
  message: string;
  /** Classification escalation if the signal is material. */
  escalation: ChangeClassification;
}

/** One node in the trigger graph: maps an event type to its handling. */
export interface TriggerNode {
  eventType: EventType;
  /** The base classification before impact analysis. */
  baseClassification: ChangeClassification;
  /** The reason code attached to replans from this trigger. */
  reasonCode: ChangeReasonCode;
  /** How to find the affected Space(s). */
  resolutionStrategy: SpaceResolutionStrategy;
  /** Whether this trigger should attempt replanning. */
  requiresReplan: boolean;
  /** Whether this trigger should produce a notification. */
  requiresNotification: boolean;
  /** Default notification priority when notification is required. */
  notificationPriority: ChangeClassification;
}

// ---------------------------------------------------------------------------
// Stage 9 — Affected spaces
// ---------------------------------------------------------------------------

/** A Space identified as potentially affected by an event. */
export interface AffectedSpace {
  userId: string;
  spaceId: string;
  date: CalendarDate;
  timeZone: TimeZone;
  planVersion: number;
  optimizedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Stage 9 — Impact analysis
// ---------------------------------------------------------------------------

/** The result of an impact analysis for a single Space. */
export interface ImpactAnalysisResult {
  /** The Space analyzed. */
  spaceId: string;
  userId: string;
  date: CalendarDate;
  /** All detected impact signals. */
  signals: ImpactSignal[];
  /** The highest-severity signal detected. */
  maxClassification: ChangeClassification;
  /** Whether the plan is materially affected. */
  hasMaterialImpact: boolean;
  /** Short audit trail explaining why replanning is or is not justified. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Stage 9 — Plan staleness
// ---------------------------------------------------------------------------

/**
 * A compact fingerprint of the inputs that matter for a plan.
 * Two identical fingerprints mean the plan is still fresh.
 */
export interface PlanFingerprint {
  /** The plan version at the time of the fingerprint. */
  planVersion: number;
  /** When the plan was last optimized (epoch ms). */
  optimizedAtMs: number;
  /** Number of open tasks at fingerprint time. */
  openTaskCount: number;
  /** Number of calendar events in the planning horizon. */
  calendarEventCount: number;
  /** Number of working-hours blocks. */
  workingHoursCount: number;
  /** Hash of task statuses (sorted task IDs + statuses). */
  taskStatusHash: string;
}

// ---------------------------------------------------------------------------
// Stage 9 — Autonomy policy
// ---------------------------------------------------------------------------

/**
 * A user commitment that must not be silently moved by the autonomous loop.
 *
 * Protected commitments include:
 *   - Tasks the user explicitly placed (not engine-placed)
 *   - Tasks the user moved within the last grace period
 *   - Tasks with a pinned status (e.g. IN_PROGRESS set by user)
 */
export interface ProtectedCommitment {
  taskId: string;
  userId: string;
  spaceId: string;
  /** Why this task is protected. */
  reason: 'USER_PLACED' | 'USER_MOVED' | 'USER_IN_PROGRESS' | 'RECENTLY_CHANGED';
  /** The timestamp of the last user-initiated change. */
  changedAt: Date;
}

/** The decision the autonomy gate produces. */
export interface AutonomyDecision {
  /** Whether the replan may proceed. */
  allowed: boolean;
  /** Why the decision was made. */
  reason: string;
  /** Tasks that must not be moved by this replan. */
  protectedTaskIds: string[];
  /** The autonomy level that produced this decision. */
  autonomyLevel: AutonomyLevel;
}

// ---------------------------------------------------------------------------
// Stage 9 — User-initiated changes / feedback-loop prevention
// ---------------------------------------------------------------------------

/** Record of a user-initiated change that the engine must respect. */
export interface UserChangeRecord {
  taskId: string;
  userId: string;
  spaceId: string;
  /** What the user changed. */
  changeType: 'STATUS' | 'SCHEDULE' | 'PRIORITY' | 'CREATED' | 'COMPLETED';
  /** The previous value, if applicable. */
  previousValue?: string;
  /** The new value. */
  newValue: string;
  /** When the change occurred. */
  occurredAt: Date;
}

// ---------------------------------------------------------------------------
// Stage 9 — Notification batching
// ---------------------------------------------------------------------------

/** A batched notification covering multiple related changes. */
export interface NotificationBatch {
  userId: string;
  spaceId: string;
  date: CalendarDate;
  /** All changes in this batch. */
  changes: NotificationBatchEntry[];
  /** The highest-priority change in the batch. */
  maxPriority: ChangeClassification;
  /** When the batch was assembled. */
  assembledAt: Date;
}

/** One change within a notification batch. */
export interface NotificationBatchEntry {
  reasonCode: ChangeReasonCode;
  message: string;
  classification: ChangeClassification;
}

// ---------------------------------------------------------------------------
// Stage 9 — Review pipeline result
// ---------------------------------------------------------------------------

/** The complete result of the enhanced review pipeline for a single Space. */
export interface SpaceReviewResult {
  userId: string;
  spaceId: string;
  date: CalendarDate;
  /** Whether a replan was enqueued. */
  replanEnqueued: boolean;
  /** Why or why not. */
  reason: string;
  /** The impact analysis, if one was performed. */
  impactAnalysis?: ImpactAnalysisResult;
  /** The autonomy decision. */
  autonomyDecision: AutonomyDecision;
  /** Whether this was a no-op (plan already current). */
  isNoOp: boolean;
  /** The notification batch, if any changes were detected. */
  notificationBatch?: NotificationBatch;
}
