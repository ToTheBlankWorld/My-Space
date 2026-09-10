import type { ConflictType, Explanation, ProposedAction, ReasonCode } from '@space/engine';
import type { CalendarDate, SpaceItemKind, TaskPriority, TimeZone } from '@space/types';

/**
 * Public types for the plan-my-day application service.
 *
 * These are the shapes the web layer renders from: the result of one planning
 * pass, the authoritative state of a day read back from the database, and the
 * identifiers every operation is scoped to.
 */

export type PlanMode = 'applied' | 'ask-before-changing' | 'suggest-only';

/** One time block assigned by the engine, joined to the item's title. */
export interface PlannedItemView {
  kind: SpaceItemKind;
  itemId: string;
  title: string;
  priority: TaskPriority | null;
  start: Date;
  end: Date | null;
  reasonCode: ReasonCode;
}

/** A task the engine could not place, with the rule that explains why. */
export interface UnplacedTaskView {
  taskId: string;
  title: string;
  priority: TaskPriority;
  reasonCode: ReasonCode;
  message: string;
}

/** An overlap or rule violation the engine detected, and how it was resolved. */
export interface ConflictView {
  type: ConflictType;
  itemIds: string[];
  description: string;
  resolution: string;
  reasonCode: ReasonCode;
}

/** The result of one complete planning pass for one space. */
export interface PlanSpaceResult {
  date: CalendarDate;
  timeZone: TimeZone;
  spaceId: string;
  planVersion: number;
  /** The autonomy mode the pass was executed under. */
  mode: PlanMode;
  /** `false` when the mode only produced suggestions (nothing was written). */
  applied: boolean;
  scheduledItems: PlannedItemView[];
  unscheduledTasks: UnplacedTaskView[];
  conflicts: ConflictView[];
  /** The database-actions the engine proposed (the AgentAction trail). */
  changes: ProposedAction[];
  explanations: Explanation[];
  durationMs: number;
}

export interface PlanSpaceRequest {
  userId: string;
  date: CalendarDate;
}

/** A lightweight identity view of a Space, for navigation and ownership checks. */
export interface SpaceView {
  id: string;
  date: CalendarDate;
  timeZone: TimeZone;
  status: 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
  planVersion: number;
  plannedAt: Date | null;
}

/** A row on the day's timeline with its concrete item attached. */
export interface DayTimelineItem {
  kind: SpaceItemKind;
  itemId: string;
  title: string;
  priority: TaskPriority | null;
  start: Date | null;
  end: Date | null;
  position: number;
}

/** A task from the day's candidate pool that is not on the timeline. */
export interface DayTask {
  id: string;
  title: string;
  priority: TaskPriority;
  status: string;
  estimatedMinutes: number | null;
}

/** A persisted explanation, stripped of the transient `factors` record. */
export interface PlanExplanation {
  itemId: string;
  kind: SpaceItemKind;
  reasonCode: ReasonCode;
  message: string;
}

/** The most recent completed planning pass, as persisted in the event log. */
export interface DayLatestPlan {
  mode: PlanMode;
  scheduled: number;
  unscheduled: number;
  conflicts: ConflictView[];
  explanations: PlanExplanation[];
  planVersion: number;
  durationMs: number;
}

/** The authoritative state of a day, read back from the database. */
export interface DayState {
  date: CalendarDate;
  timeZone: TimeZone;
  spaceId: string;
  status: 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
  planVersion: number;
  plannedAt: Date | null;
  planned: DayTimelineItem[];
  unscheduled: DayTask[];
  latestPlan: DayLatestPlan | null;
  /** When this read was produced, from the injected clock. */
  generatedAt: Date;
}
