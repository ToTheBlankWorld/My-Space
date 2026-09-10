/**
 * `@space/planning` — the plan-my-day application service.
 *
 * Server-only. Owns the "plan this space" operation: load the snapshot, run the
 * deterministic engine (`@space/engine`), persist under the autonomy policy with
 * an optimistic version claim, and audit every pass. The same service is used by
 * the web request handler today and can be handed to a worker job without moving
 * the logic.
 */

export { createPlanSpaceService } from './service';
export type { PlanSpaceService, PlanSpaceServiceDeps } from './service';

export { loadPlanningInput, loadTimeZone, dedupeById } from './snapshot';
export type { LoadPlanningInputArgs } from './snapshot';

export {
  persistPlanningResult,
  buildPlanningCompletedPayload,
  planningCompletedPayloadSchema,
} from './persist';
export type { PersistPlanningArgs, PersistOutcome, PlanningCompletedPayload } from './persist';

export { loadDayState, loadDayTaskPool } from './day-state';
export type { LoadDayStateArgs, DayTaskPoolRow } from './day-state';

export {
  PlanInvalidDateError,
  PlanSpaceNotFoundError,
  PlanVersionConflictError,
  PlanInputInvalidError,
  PlanFailedError,
  isPlanServiceError,
} from './errors';
export type { PlanErrorCode, PlanServiceError } from './errors';

export { planErrorHttpStatus } from './http';

export type {
  PlanMode,
  PlanSpaceResult,
  PlanSpaceRequest,
  SpaceView,
  PlannedItemView,
  UnplacedTaskView,
  ConflictView,
  PlanExplanation,
  DayState,
  DayLatestPlan,
  DayTimelineItem,
  DayTask,
} from './types';
