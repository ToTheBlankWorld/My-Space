import type { Database } from '@space/database';
import { calendarDateRange } from '@space/time';

import type { AffectedSpace, PlanFingerprint } from './types';

/**
 * Plan staleness model.
 *
 * A plan is "fresh" when its inputs have not materially changed since it was
 * last computed. Rather than comparing every input field, we build a compact
 * fingerprint of the inputs that matter and compare it against the plan's
 * timestamp and version.
 *
 * The staleness check is conservative: when in doubt, it returns "stale"
 * (true) so the replan proceeds. False positives are cheap (an unnecessary
 * replan that produces a no-op diff); false negatives are expensive (a stale
 * plan that the user sees as wrong).
 *
 * This module is query-only — it reads the database but never writes.
 */

/** How old (in ms) a plan can be before it is considered potentially stale. */
export const STALENESS_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

/** Maximum age of a plan before it is unconditionally stale. */
export const MAX_PLAN_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Builds a fingerprint of the current inputs for a Space's plan.
 *
 * Two identical fingerprints mean the plan's inputs have not changed. The
 * fingerprint is intentionally lightweight — it captures the high-level
 * shape of the day, not every field.
 */
export const buildPlanFingerprint = async (
  db: Database,
  space: AffectedSpace,
): Promise<PlanFingerprint> => {
  const { userId, spaceId } = space;

  // Count open tasks in this space.
  const openTaskCount = await db.task.count({
    where: {
      userId,
      spaceId,
      status: { in: ['INBOX', 'PLANNED', 'IN_PROGRESS', 'RESCHEDULED'] },
    },
  });

  // Count calendar events in the planning horizon.
  const { start, end } = calendarDateRange(space.date, space.timeZone);
  const calendarEventCount = await db.calendarEvent.count({
    where: {
      userId,
      deletedAt: null,
      startAt: { lt: end },
      endAt: { gt: start },
    },
  });

  // Count working-hours blocks.
  const workingHoursCount = await db.workingHoursBlock.count({
    where: { userId },
  });

  // Build a task status hash: sorted (taskId, status) pairs joined.
  const tasks = await db.task.findMany({
    where: {
      userId,
      spaceId,
      status: { in: ['INBOX', 'PLANNED', 'IN_PROGRESS', 'RESCHEDULED', 'COMPLETED', 'CANCELLED'] },
    },
    select: { id: true, status: true },
    orderBy: { id: 'asc' },
  });

  const taskStatusHash = tasks.map((t) => `${t.id}:${t.status}`).join('|');

  return {
    planVersion: space.planVersion,
    optimizedAtMs: space.optimizedAt?.getTime() ?? 0,
    openTaskCount,
    calendarEventCount,
    workingHoursCount,
    taskStatusHash,
  };
};

/**
 * Determines whether a Space's plan is stale.
 *
 * A plan is stale when:
 *   1. It has never been planned (planVersion === 0), OR
 *   2. It is older than MAX_PLAN_AGE_MS, OR
 *   3. It has not been optimized within the STALENESS_THRESHOLD_MS window.
 *
 * The check is conservative: when in doubt it returns "stale" so the replan
 * proceeds and the plan diff proves whether work actually moved. False
 * positives are cheap (a no-op replan); false negatives are expensive.
 *
 * `db` is retained for signature stability and future fingerprint comparisons.
 *
 * Returns `{ stale: true, reason }` or `{ stale: false }`.
 */
export const checkPlanStaleness = (
  _db: Database,
  space: AffectedSpace,
  now: Date,
): { stale: boolean; reason?: string } => {
  // Never-planned spaces are always stale.
  if (space.planVersion === 0) {
    return { stale: true, reason: 'Space has never been planned (planVersion=0).' };
  }

  // Unconditionally stale if the plan is very old.
  if (
    MAX_PLAN_AGE_MS > 0 &&
    space.optimizedAt !== null &&
    now.getTime() - space.optimizedAt.getTime() > MAX_PLAN_AGE_MS
  ) {
    return { stale: true, reason: `Plan is older than ${MAX_PLAN_AGE_MS / 3_600_000} hours.` };
  }

  // The primary staleness signal: age of the last optimization relative to the
  // staleness threshold. Plans that were just optimized are fresh; anything
  // older is conservatively considered stale so the replan proceeds and the
  // diff proves whether work actually moved.
  if (
    space.optimizedAt !== null &&
    now.getTime() - space.optimizedAt.getTime() < STALENESS_THRESHOLD_MS
  ) {
    return { stale: false };
  }

  return { stale: true, reason: 'Plan age exceeds staleness threshold.' };
};

/**
 * Quick staleness check without a database read.
 *
 * Used by the service when the Space data is already loaded. Returns true
 * when the plan is likely stale based on the available information.
 */
export const isPlanLikelyStale = (space: AffectedSpace, now: Date): boolean => {
  if (space.planVersion === 0) return true;
  if (space.optimizedAt === null) return true;

  const ageMs = now.getTime() - space.optimizedAt.getTime();
  if (MAX_PLAN_AGE_MS > 0 && ageMs > MAX_PLAN_AGE_MS) return true;
  if (STALENESS_THRESHOLD_MS > 0 && ageMs > STALENESS_THRESHOLD_MS) return true;

  return false;
};
