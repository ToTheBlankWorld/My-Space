import type { Database } from '@space/database';
import type { Clock } from '@space/time';

import type { UserChangeRecord } from './types';
import { getRecentUserChanges } from './policy';

/**
 * Feedback-loop prevention.
 *
 * Prevents the autonomous loop from fighting the user:
 *   1. User moves task A → engine replans → task A is moved back → user moves A
 *      again → infinite loop.
 *   2. User completes task B → engine replans → task B reappears → user completes
 *      it again.
 *
 * Strategy:
 *   - After a user-initiated change, suppress autonomous replans for that
 *     specific task for a configurable grace period.
 *   - When a replan IS forced (e.g. by a deadline), respect protected tasks:
 *     the engine may schedule around them but must not move them.
 *   - Track replan→user-change→replan cycles and escalate to the user when
 *     a cycle is detected.
 *
 * This module is query-only (reads event log and task state) with no writes.
 */

/** How long to suppress autonomous replans after a user-initiated change. */
const SUPPRESSION_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/** How many user-change→replan cycles before escalating. */
const CYCLE_ESCALATION_THRESHOLD = 3;

/** The time window to detect cycles. */
const CYCLE_DETECTION_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface FeedbackLoopCheckResult {
  /** Whether the autonomous replan should be suppressed for this task. */
  suppressed: boolean;
  /** Why. */
  reason: string;
  /** The user change that triggered suppression, if any. */
  triggerChange?: UserChangeRecord;
  /** Whether a feedback-loop cycle was detected. */
  cycleDetected: boolean;
  /** The number of cycles detected in the window. */
  cycleCount: number;
}

/**
 * Checks whether an autonomous replan should be suppressed for a specific task
 * to prevent feedback loops.
 */
export const checkFeedbackLoop = async (
  db: Database,
  clock: Clock,
  userId: string,
  spaceId: string,
  taskId: string,
): Promise<FeedbackLoopCheckResult> => {
  const now = clock.now();

  // 1. Find recent user-initiated changes for this task.
  const recentChanges = await getRecentUserChanges(
    db,
    clock,
    userId,
    spaceId,
    SUPPRESSION_WINDOW_MS,
  );
  const taskChange = recentChanges.find((c) => c.taskId === taskId);

  if (taskChange) {
    return {
      suppressed: true,
      reason: `Task ${taskId} was user-changed ${formatDuration(now, taskChange.occurredAt)} ago; suppressing autonomous replan.`,
      triggerChange: taskChange,
      cycleDetected: false,
      cycleCount: 0,
    };
  }

  // 2. Detect replan→user-change→replan cycles.
  const cycleCount = await detectReplanCycles(db, clock, userId, taskId);
  if (cycleCount >= CYCLE_ESCALATION_THRESHOLD) {
    return {
      suppressed: false, // Don't suppress, but escalate.
      reason: `Feedback-loop cycle detected: ${cycleCount} replan→user-change cycles for task ${taskId}.`,
      cycleDetected: true,
      cycleCount,
    };
  }

  return {
    suppressed: false,
    reason: 'No feedback-loop signals detected.',
    cycleDetected: false,
    cycleCount,
  };
};

/**
 * Detects replan→user-change→replan cycles for a task.
 *
 * A cycle is: autonomous replan moves task → user moves it back → autonomous
 * replan moves it again. We count these by looking at alternating
 * SPACE_OPTIMIZED (autonomous) and TASK_RESCHEDULED/TASK_COMPLETED (user)
 * events for the same task.
 */
const detectReplanCycles = async (
  db: Database,
  clock: Clock,
  userId: string,
  taskId: string,
): Promise<number> => {
  const now = clock.now();
  const since = new Date(now.getTime() - CYCLE_DETECTION_WINDOW_MS);

  // Get autonomous replans that affected this task (SPACE_OPTIMIZED events).
  const replanEvents = await db.eventLog.findMany({
    where: {
      userId,
      eventType: 'SPACE_OPTIMIZED',
      occurredAt: { gte: since },
    },
    select: { occurredAt: true, payload: true },
    orderBy: { sequence: 'asc' },
    take: 50,
  });

  // Get user-initiated changes for this task.
  const userChanges = await db.eventLog.findMany({
    where: {
      userId,
      aggregateType: 'TASK',
      aggregateId: taskId,
      occurredAt: { gte: since },
      OR: [
        { eventType: 'TASK_RESCHEDULED' },
        { eventType: 'TASK_COMPLETED' },
        { eventType: 'TASK_UPDATED' },
      ],
    },
    select: { occurredAt: true, payload: true },
    orderBy: { sequence: 'asc' },
    take: 50,
  });

  // Cycle detection: count user changes that happened within the suppression
  // window after an autonomous replan — a replan→user-change→replan pattern.
  let cycles = 0;

  for (const userChange of userChanges) {
    const payload = userChange.payload as { trigger?: string } | null;
    if (payload?.trigger !== 'user') continue;

    // Is there an autonomous replan within the suppression window before this change?
    const hasPrecedingReplan = replanEvents.some(
      (r) =>
        r.occurredAt.getTime() < userChange.occurredAt.getTime() &&
        userChange.occurredAt.getTime() - r.occurredAt.getTime() < SUPPRESSION_WINDOW_MS,
    );

    if (hasPrecedingReplan) {
      cycles += 1;
    }
  }

  return cycles;
};

/**
 * Checks whether a specific task should be excluded from autonomous replanning
 * based on the feedback-loop check result.
 */
export const shouldExcludeFromReplan = (result: FeedbackLoopCheckResult): boolean =>
  result.suppressed;

/**
 * Formats a duration between two dates as a human-readable string.
 */
const formatDuration = (later: Date, earlier: Date): string => {
  const ms = later.getTime() - earlier.getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'moments';
  if (minutes === 1) return '1 minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour';
  return `${hours} hours`;
};
