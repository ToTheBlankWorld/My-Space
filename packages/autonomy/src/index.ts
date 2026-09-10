export { classifyChange, atLeast, classificationRank, IMPACT_HORIZON_DAYS } from './change';
export type { ClassifiedChange, ChangeClassification, ChangeReasonCode } from './types';
export { computePlanDiff } from './diff';
export type { PlanDiff, PlanDiffEntry, PlanDiffType, PlanDiffReasonCode } from './types';
export {
  createAutonomyService,
  DEFAULT_COALESCE_WINDOW_MS,
  DEFAULT_DEADLINE_REPLAN_WINDOW_MS,
  DEFAULT_MAX_REVIEW_USERS,
  DEFAULT_MAX_EVENTS_PER_PASS,
  TRIGGER_SCAN_WINDOW_MS,
} from './service';
export type { AutonomyService, AutonomyServiceDeps } from './service';
export type { MissedTaskCase, DeadlineCase, ReplanRequest, ReviewSummary } from './types';
export {
  CHANGE_CLASSIFICATIONS,
  CHANGE_REASON_CODES,
  PLAN_DIFF_TYPES,
  PLAN_DIFF_REASON_CODES,
} from './types';

// Stage 9 — Trigger graph
export {
  resolveTriggerNode,
  allTriggerNodes,
  REPLAN_EVENT_TYPES,
  NOTIFICATION_EVENT_TYPES,
} from './trigger-graph';

// Stage 9 — Affected-space detection
export { resolveAffectedSpaces } from './affected-spaces';
export type { AffectedSpace } from './types';

// Stage 9 — Impact analysis
export { analyzeImpact } from './impact';
export type { ImpactAnalysisResult, ImpactSignal, ImpactSignalKind } from './types';

// Stage 9 — Plan staleness
export {
  checkPlanStaleness,
  isPlanLikelyStale,
  buildPlanFingerprint,
  STALENESS_THRESHOLD_MS,
  MAX_PLAN_AGE_MS,
} from './staleness';
export type { PlanFingerprint } from './types';

// Stage 9 — Autonomy policy
export { evaluateAutonomy, isTaskProtected, getRecentUserChanges } from './policy';
export type { AutonomyDecision, ProtectedCommitment, UserChangeRecord } from './types';

// Stage 9 — Feedback-loop prevention
export { checkFeedbackLoop, shouldExcludeFromReplan } from './feedback-loop';
export type { FeedbackLoopCheckResult } from './feedback-loop';

// Stage 9 — Notification batching
export {
  createNotificationBatch,
  summarizeBatch,
  batchTitle,
  mergeBatches,
} from './notification-batching';
export type { NotificationBatch, NotificationBatchEntry } from './types';

// Stage 9 — Enhanced types
export type { TriggerNode, SpaceResolutionStrategy, SpaceReviewResult } from './types';
