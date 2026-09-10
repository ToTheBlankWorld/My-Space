import type { Database } from '@space/database';
import type { Clock } from '@space/time';
import type { AutonomyLevel, EventType } from '@space/types';

import type {
  AffectedSpace,
  AutonomyDecision,
  ProtectedCommitment,
  UserChangeRecord,
} from './types';

/**
 * Autonomy policy enforcement.
 *
 * Gates every autonomous action against the user's autonomy preference and
 * the set of protected commitments. Three autonomy levels:
 *
 *   SUGGEST_ONLY          — never write; only record suggestions.
 *   ASK_BEFORE_CHANGING   — write new placements, but never move existing items.
 *   AUTOMATICALLY_MANAGE  — full replan with all moves allowed.
 *
 * Protected commitments are tasks the user has explicitly interacted with
 * recently (placed, moved, set to IN_PROGRESS). The autonomous loop must
 * never silently move these — doing so would fight the user and erode trust.
 *
 * This module queries the database for user preferences and recent user
 * actions, then returns an AutonomyDecision that gates the replan.
 */

/** How far back to look for user-initiated changes (ms). */
const USER_CHANGE_GRACE_MS = 30 * 60 * 1000; // 30 minutes

export interface EvaluateAutonomyArgs {
  db: Database;
  userId: string;
  space: AffectedSpace;
  eventType: EventType;
}

/**
 * Evaluates the autonomy policy for a proposed replan.
 *
 * Returns an AutonomyDecision indicating whether the replan may proceed,
 * which tasks are protected, and why the decision was made.
 */
export const evaluateAutonomy = async (
  db: Database,
  clock: Clock,
  args: EvaluateAutonomyArgs,
): Promise<AutonomyDecision> => {
  const { userId, space, eventType } = args;

  // 1. Load the user's autonomy level.
  const prefs = await db.planningPreferences.findUnique({
    where: { userId },
    select: { autonomyLevel: true },
  });
  const autonomyLevel: AutonomyLevel = prefs?.autonomyLevel ?? 'ASK_BEFORE_CHANGING';

  // 2. SUGGEST_ONLY never allows autonomous writes.
  if (autonomyLevel === 'SUGGEST_ONLY') {
    return {
      allowed: false,
      reason: 'Autonomy level is SUGGEST_ONLY; no autonomous writes are permitted.',
      protectedTaskIds: [],
      autonomyLevel,
    };
  }

  // 3. Resolve protected commitments.
  const protectedCommitments = await resolveProtectedCommitments(db, clock, userId, space.spaceId);
  const protectedTaskIds = protectedCommitments.map((c) => c.taskId);

  // 4. Check if the triggering event is a user-initiated change.
  const isUserInitiated = eventType === 'TASK_COMPLETED' || eventType === 'TASK_RESCHEDULED';

  // 5. For ASK_BEFORE_CHANGING, allow new placements but protect existing items.
  if (autonomyLevel === 'ASK_BEFORE_CHANGING') {
    if (isUserInitiated) {
      return {
        allowed: true,
        reason: 'User-initiated change; proceeding with replan while protecting user commitments.',
        protectedTaskIds,
        autonomyLevel,
      };
    }

    return {
      allowed: true,
      reason:
        'ASK_BEFORE_CHANGING: new placements allowed, existing items protected by the persist layer.',
      protectedTaskIds,
      autonomyLevel,
    };
  }

  // 6. AUTOMATICALLY_MANAGE: full replan, but still respect protected commitments.
  return {
    allowed: true,
    reason: 'AUTOMATICALLY_MANAGE: full autonomous replan permitted.',
    protectedTaskIds,
    autonomyLevel,
  };
};

/**
 * Resolves protected commitments for a Space.
 *
 * A task is protected when:
 *   1. The user set it to IN_PROGRESS recently (within the grace period).
 *   2. The user explicitly placed it (its scheduledStart was set by a user
 *      action, not by the engine).
 *   3. The user moved it recently (a TASK_RESCHEDULED event from a user trigger).
 */
const resolveProtectedCommitments = async (
  db: Database,
  clock: Clock,
  userId: string,
  spaceId: string,
): Promise<ProtectedCommitment[]> => {
  const now = clock.now();
  const commitments: ProtectedCommitment[] = [];

  // 1. Tasks set to IN_PROGRESS by the user recently.
  const inProgressTasks = await db.task.findMany({
    where: {
      userId,
      spaceId,
      status: 'IN_PROGRESS',
    },
    select: { id: true, updatedAt: true },
  });

  for (const task of inProgressTasks) {
    if (now.getTime() - task.updatedAt.getTime() < USER_CHANGE_GRACE_MS) {
      commitments.push({
        taskId: task.id,
        userId,
        spaceId,
        reason: 'USER_IN_PROGRESS',
        changedAt: task.updatedAt,
      });
    }
  }

  // 2. Tasks that have a user-initiated schedule change in the event log.
  const recentRescheduled = await db.eventLog.findMany({
    where: {
      userId,
      eventType: 'TASK_RESCHEDULED',
      aggregateType: 'TASK',
      occurredAt: { gte: new Date(now.getTime() - USER_CHANGE_GRACE_MS) },
    },
    select: { aggregateId: true, occurredAt: true, payload: true },
    orderBy: { sequence: 'desc' },
    take: 20,
  });

  for (const event of recentRescheduled) {
    const payload = event.payload as { trigger?: string } | null;
    if (payload?.trigger === 'user' && event.aggregateId) {
      // Check not already protected.
      if (!commitments.some((c) => c.taskId === event.aggregateId)) {
        commitments.push({
          taskId: event.aggregateId,
          userId,
          spaceId,
          reason: 'USER_MOVED',
          changedAt: event.occurredAt,
        });
      }
    }
  }

  // 3. Tasks completed by the user recently.
  const recentCompleted = await db.eventLog.findMany({
    where: {
      userId,
      eventType: 'TASK_COMPLETED',
      aggregateType: 'TASK',
      occurredAt: { gte: new Date(now.getTime() - USER_CHANGE_GRACE_MS) },
    },
    select: { aggregateId: true, occurredAt: true, payload: true },
    orderBy: { sequence: 'desc' },
    take: 10,
  });

  for (const event of recentCompleted) {
    if (event.aggregateId && !commitments.some((c) => c.taskId === event.aggregateId)) {
      commitments.push({
        taskId: event.aggregateId,
        userId,
        spaceId,
        reason: 'USER_PLACED',
        changedAt: event.occurredAt,
      });
    }
  }

  return commitments;
};

/**
 * Checks if a specific task is protected from autonomous movement.
 */
export const isTaskProtected = (protectedTaskIds: readonly string[], taskId: string): boolean =>
  protectedTaskIds.includes(taskId);

/**
 * Retrieves recent user-initiated changes for a Space.
 * Used by the feedback-loop prevention system.
 */
export const getRecentUserChanges = async (
  db: Database,
  clock: Clock,
  userId: string,
  spaceId: string,
  lookbackMs: number = USER_CHANGE_GRACE_MS,
): Promise<UserChangeRecord[]> => {
  const now = clock.now();
  const since = new Date(now.getTime() - lookbackMs);

  const events = await db.eventLog.findMany({
    where: {
      userId,
      occurredAt: { gte: since },
      OR: [
        { eventType: 'TASK_COMPLETED', aggregateType: 'TASK' },
        { eventType: 'TASK_RESCHEDULED', aggregateType: 'TASK' },
        { eventType: 'TASK_UPDATED', aggregateType: 'TASK' },
        { eventType: 'TASK_CREATED', aggregateType: 'TASK' },
      ],
    },
    select: {
      eventType: true,
      aggregateId: true,
      occurredAt: true,
      payload: true,
    },
    orderBy: { sequence: 'desc' },
    take: 50,
  });

  return events
    .filter((e): e is typeof e & { aggregateId: string } => e.aggregateId !== null)
    .map((e) => {
      const payload = e.payload as Record<string, unknown> | null;
      const trigger = payload?.trigger as string | undefined;
      return {
        taskId: e.aggregateId,
        userId,
        spaceId,
        changeType: mapEventTypeToChangeType(e.eventType),
        previousValue: (payload?.from as string) ?? undefined,
        newValue: (payload?.to as string) ?? (payload?.status as string) ?? 'unknown',
        occurredAt: e.occurredAt,
        isUserInitiated: trigger === 'user',
      };
    })
    .filter((r) => r.isUserInitiated)
    .map(({ isUserInitiated: _, ...rest }) => rest);
};

const mapEventTypeToChangeType = (eventType: string): UserChangeRecord['changeType'] => {
  switch (eventType) {
    case 'TASK_COMPLETED':
      return 'COMPLETED';
    case 'TASK_RESCHEDULED':
      return 'SCHEDULE';
    case 'TASK_UPDATED':
      return 'PRIORITY';
    case 'TASK_CREATED':
      return 'CREATED';
    default:
      return 'STATUS';
  }
};
