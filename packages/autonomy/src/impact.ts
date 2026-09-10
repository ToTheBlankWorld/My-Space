import type { Database } from '@space/database';
import { calendarDateRange } from '@space/time';
import type {
  AffectedSpace,
  ChangeClassification,
  ImpactAnalysisResult,
  ImpactSignal,
} from './types';

/**
 * Pre-replan impact analysis.
 *
 * Before enqueueing a replan, determines whether the detected change actually
 * affects the current plan for the affected Space. This avoids unnecessary
 * replans: a task update that does not change the schedule, a calendar sync
 * that imports events far outside the planning horizon, or a reminder
 * creation that has no bearing on the day's blocks.
 *
 * Each signal is a pure function of the current database state and the
 * triggering event. The analysis never writes — it returns a structured
 * result that the service uses to decide whether to proceed.
 */

export interface AnalyzeImpactArgs {
  db: Database;
  space: AffectedSpace;
  eventType: string;
  reasonCode: string;
  /** The entity that triggered the event, if applicable. */
  entityId?: string;
  /** The event's payload, for extracting additional context. */
  payload?: Record<string, unknown>;
}

/** The open task statuses that participate in impact analysis. */
const OPEN_STATUSES = ['INBOX', 'PLANNED', 'IN_PROGRESS', 'RESCHEDULED'] as const;

/**
 * Analyzes the impact of an event on a Space's current plan.
 *
 * Returns an ImpactAnalysisResult with all detected signals and a
 * material-impact boolean. The service uses this to skip replanning when
 * there is no material impact.
 */
export const analyzeImpact = async (
  db: Database,
  args: AnalyzeImpactArgs,
): Promise<ImpactAnalysisResult> => {
  const { space, eventType, entityId, payload } = args;
  const signals: ImpactSignal[] = [];

  // 1. Check if the Space has an active plan to affect.
  if (space.planVersion === 0) {
    return {
      spaceId: space.spaceId,
      userId: space.userId,
      date: space.date,
      signals: [],
      maxClassification: 'NO_REPLAN',
      hasMaterialImpact: false,
      rationale: 'Space has no active plan (planVersion=0).',
    };
  }

  // 2. Detect schedule collision for the triggering entity.
  if (entityId && (eventType === 'TASK_UPDATED' || eventType === 'TASK_CREATED')) {
    const collision = await detectScheduleCollision(db, space, entityId);
    if (collision) signals.push(collision);
  }

  // 3. Detect calendar drift: calendar events changed within the planning horizon.
  if (eventType === 'CALENDAR_CHANGED' || eventType === 'CALENDAR_SYNCED') {
    const drift = await detectCalendarDrift(db, space, payload);
    if (drift) signals.push(drift);
  }

  // 4. Detect deadline risk for the triggering entity.
  if (entityId && (eventType === 'TASK_UPDATED' || eventType === 'TASK_CREATED')) {
    const deadline = await detectDeadlineRisk(db, space, entityId);
    if (deadline) signals.push(deadline);
  }

  // 5. Detect dependency break: the triggering task had dependents.
  if (entityId && eventType === 'TASK_UPDATED') {
    const depBreak = await detectDependencyBreak(db, space, entityId);
    if (depBreak) signals.push(depBreak);
  }

  // 6. Detect workload imbalance: too many tasks for the day's availability.
  const workload = await detectWorkloadImbalance(db, space);
  if (workload) signals.push(workload);

  // 7. Detect newly available time: a task was completed or cancelled.
  if (
    eventType === 'TASK_COMPLETED' ||
    (eventType === 'TASK_UPDATED' && payload?.status === 'CANCELLED')
  ) {
    signals.push({
      kind: 'NEWLY_AVAILABLE',
      entityId,
      message: 'A task was completed or cancelled; freed time may be reused.',
      escalation: 'REPLAN_REQUIRED',
    });
  }

  // Compute max classification and material impact.
  const classificationRank: Record<ChangeClassification, number> = {
    NO_REPLAN: 0,
    REVIEW_ONLY: 1,
    REPLAN_REQUIRED: 2,
    URGENT_REPLAN: 3,
  };

  let maxRank = 0;
  let maxClassification: ChangeClassification = 'NO_REPLAN';
  for (const signal of signals) {
    const rank = classificationRank[signal.escalation];
    if (rank > maxRank) {
      maxRank = rank;
      maxClassification = signal.escalation;
    }
  }

  const hasMaterialImpact = signals.length > 0;

  return {
    spaceId: space.spaceId,
    userId: space.userId,
    date: space.date,
    signals,
    maxClassification,
    hasMaterialImpact,
    rationale: hasMaterialImpact
      ? `${signals.length} impact signal(s) detected: ${signals.map((s) => s.kind).join(', ')}.`
      : 'No material impact detected; plan is still valid.',
  };
};

// ---------------------------------------------------------------------------
// Signal detectors
// ---------------------------------------------------------------------------

const detectScheduleCollision = async (
  db: Database,
  space: AffectedSpace,
  taskId: string,
): Promise<ImpactSignal | null> => {
  const task = await db.task.findFirst({
    where: { id: taskId, userId: space.userId },
    select: { id: true, scheduledStart: true, scheduledEnd: true, estimatedMinutes: true },
  });
  if (!task || !task.scheduledStart || !task.scheduledEnd) return null;

  // Check for overlapping tasks in the same Space.
  const overlapping = await db.task.findMany({
    where: {
      userId: space.userId,
      id: { not: taskId },
      spaceId: space.spaceId,
      status: { in: [...OPEN_STATUSES] },
      scheduledStart: { lt: task.scheduledEnd },
      scheduledEnd: { gt: task.scheduledStart },
    },
    select: { id: true, title: true },
    take: 5,
  });

  if (overlapping.length === 0) return null;

  return {
    kind: 'SCHEDULE_COLLISION',
    entityId: taskId,
    message: `Task ${taskId} overlaps with ${overlapping.length} other task(s) in this Space.`,
    escalation: 'REPLAN_REQUIRED',
  };
};

const detectCalendarDrift = async (
  db: Database,
  space: AffectedSpace,
  payload: Record<string, unknown> | undefined,
): Promise<ImpactSignal | null> => {
  const calendarId = payload?.calendarId as string | undefined;
  if (!calendarId) return null;

  // Check if any calendar events in the Space's date range were changed.
  const { start, end } = calendarDateRange(space.date, space.timeZone);
  const calEvents = await db.calendarEvent.findMany({
    where: {
      userId: space.userId,
      calendarId,
      deletedAt: null,
      startAt: { lt: end },
      endAt: { gt: start },
    },
    select: { id: true, title: true },
    take: 5,
  });

  if (calEvents.length === 0) return null;

  return {
    kind: 'CALENDAR_DRIFT',
    message: `${calEvents.length} calendar event(s) changed within the planning horizon.`,
    escalation: 'REPLAN_REQUIRED',
  };
};

const detectDeadlineRisk = async (
  db: Database,
  space: AffectedSpace,
  taskId: string,
): Promise<ImpactSignal | null> => {
  const task = await db.task.findFirst({
    where: { id: taskId, userId: space.userId },
    select: { id: true, dueAt: true, scheduledEnd: true },
  });
  if (!task || !task.dueAt) return null;

  // Is the deadline at risk? Only if the task is not yet scheduled to finish before the deadline.
  if (task.scheduledEnd && task.scheduledEnd.getTime() <= task.dueAt.getTime()) {
    return null;
  }

  return {
    kind: 'DEADLINE_RISK',
    entityId: taskId,
    message: `Task ${taskId} has a deadline that may not be met by its current placement.`,
    escalation: 'REPLAN_REQUIRED',
  };
};

const detectDependencyBreak = async (
  db: Database,
  space: AffectedSpace,
  taskId: string,
): Promise<ImpactSignal | null> => {
  // Find tasks that depend on this task.
  const dependents = await db.taskDependency.findMany({
    where: { userId: space.userId, dependsOnId: taskId },
    select: { taskId: true },
    take: 5,
  });

  if (dependents.length === 0) return null;

  return {
    kind: 'DEPENDENCY_BREAK',
    entityId: taskId,
    message: `${dependents.length} task(s) depend on this task; their schedule may be affected.`,
    escalation: 'REPLAN_REQUIRED',
  };
};

const detectWorkloadImbalance = async (
  db: Database,
  space: AffectedSpace,
): Promise<ImpactSignal | null> => {
  const openTasks = await db.task.count({
    where: {
      userId: space.userId,
      spaceId: space.spaceId,
      status: { in: [...OPEN_STATUSES] },
    },
  });

  const plannedTasks = await db.task.count({
    where: {
      userId: space.userId,
      spaceId: space.spaceId,
      status: 'PLANNED',
    },
  });

  // Heuristic: if more than 12 open tasks in a single day, flag workload.
  if (openTasks > 12) {
    return {
      kind: 'WORKLOAD_IMBALANCE',
      message: `${openTasks} open tasks in this Space; workload may exceed available time.`,
      escalation: 'REPLAN_REQUIRED',
    };
  }

  // If the ratio of planned to total open tasks is very low, the plan is incomplete.
  if (openTasks > 3 && plannedTasks === 0) {
    return {
      kind: 'WORKLOAD_IMBALANCE',
      message: `${openTasks} open tasks but none are planned; the Space needs planning.`,
      escalation: 'REPLAN_REQUIRED',
    };
  }

  return null;
};
