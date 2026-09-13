import { createAutonomyService, type AutonomyServiceDeps, type ReviewSummary } from '@space/autonomy';
import type { Database } from '@space/database';
import type { Logger } from '@space/logger';
import type { Clock } from '@space/time';

/**
 * The autonomy review processor — the body of the PostgreSQL autonomy handler.
 *
 * One job runs one full review pass over all users with planning preferences.
 * The review never plans directly: it classifies change events (trigger graph,
 * missed blocks, at-risk deadlines, stale plans, unplanned tomorrows), applies
 * the autonomy policy, feedback-loop guard, URGENT/REPLAN/REVIEW suppression
 * and optimizedAt coalescing, then delegates every affected day to the
 * caller's `enqueueReplan` sink, which coalesces a `BackgroundJob` by
 * `dedupeKey`.
 */

export interface AutonomyReviewJobDeps {
  db: Database;
  clock: Clock;
  logger: Logger;
  /** APP_URL — passed to the notification policy for deep links. */
  appUrl: string;
  /** Adds one replan request to the planning queue (coalesced by spaceId). */
  enqueueReplan: AutonomyServiceDeps['enqueueReplan'];
  maxReviewUsers?: number;
}

export const processAutonomyReviewJob = async (
  deps: AutonomyReviewJobDeps,
): Promise<ReviewSummary> => {
  const service = createAutonomyService({
    db: deps.db,
    clock: deps.clock,
    logger: deps.logger,
    appUrl: deps.appUrl,
    enqueueReplan: deps.enqueueReplan,
    maxReviewUsers: deps.maxReviewUsers,
  });

  return service.review();
};
