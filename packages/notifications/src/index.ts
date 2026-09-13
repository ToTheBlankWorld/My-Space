/**
 * `@space/notifications` — the Stage 7 notification engine.
 *
 * ## Packages
 *
 * - **Policy** (`policy.ts`) — deterministic *what/howloud* decisions over facts.
 * - **Templates** (`templates.ts`) — validated, HTML-safe email rendering.
 * - **Provider** (`provider.ts`) — the email transport contract (AgentMail default).
 * - **Outbox consumer** (`outbox.ts`) — turns PLANNING_COMPLETED events into
 *   durable, idempotently-keyed plan-change notifications.
 * - **Reminder dispatcher** (`reminders.ts`) — due reminders become notifications.
 * - **Sweep** (`sweep.ts`) — the deterministic interval that owns the daily
 *   cycle, outbox cursor, reminder dispatch and delivery enqueueing.
 * - **Service** (`service.ts`) — sweep orchestration + the delivery worker's
 *   queue-independent core.
 *
 * ## Boundaries
 *
 * - Nothing here talks to a broker: the durable queue lives in the worker and
 *   the worker; credentials live in worker config. `SweepDeps.enqueueDelivery`
 *   is the only seam.
 * - Policy never uses a clock or the database; the sweep owns both.
 * - Email verdicts (`SENT`/`FAILED`) are written to `email_logs`, never the
 *   rendered body, and provider tokens never leave worker configuration.
 */

export { TEMPLATE_NAMES, DAILY_SLOTS } from './types';
export type {
  TemplateName,
  DailySlot,
  EmailDirective,
  NotificationDraft,
  PendingEmail,
} from './types';

export {
  DAILY_BRIEF_KEY,
  PLAN_CHANGE_KEY,
  DEADLINE_WARNING_KEY,
  TASK_MISSED_KEY,
  REMINDER_KEY,
  REMINDER_OCCURRENCE_KEY,
} from './keys';

export {
  evaluateDailyBrief,
  evaluateDeadlineWarning,
  evaluateTaskMissed,
  evaluatePlanCompletion,
} from './policy';
export type {
  UserNotificationSettings,
  DailyCycleFacts,
  DailySlotInstant,
  DeadlineCandidate,
  MissedTaskCandidate,
  PlanCompletionFacts,
  PreviousPlanSummary,
} from './policy';

export { renderEmail, templateDataSchemas, formatDate } from './templates';
export type { TemplateData } from './templates';

export { AgentMailProvider, createEmailProvider, classifyProviderHttpError } from './provider';
export type {
  EmailProvider,
  EmailProviderConfig,
  EmailSendRequest,
  EmailSendResult,
  ProviderFailure,
  ProviderFailureKind,
} from './provider';

export { consumeOutbox, PROCESSOR_NAME } from './outbox';
export type { OutboxConsumeResult, OutboxDeps } from './outbox';

export { dispatchReminders } from './reminders';
export type { ReminderDispatchResult, ReminderDispatchDeps } from './reminders';

export { runSweep, reconcileDailyCycles, prepareDeliveries, createDraft } from './sweep';
export type {
  SweepDeps,
  SweepResult,
  DeliveryPayload,
  DailyCycleResult,
  DeliveryPreparationResult,
} from './sweep';

export {
  createNotificationService,
  deliverQueuedEmail,
  finalizeFailedDelivery,
  RetryableDeliveryError,
} from './service';
export type {
  NotificationService,
  DeliveryServiceDeps,
  DeliveryAttemptDeps,
  DeliveryAttemptResult,
} from './service';
