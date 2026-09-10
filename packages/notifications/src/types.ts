import type { NotificationPriority, NotificationType } from '@space/types';

/**
 * Shared vocabulary of the notification pipeline.
 *
 * The pipeline is strictly separated between *what* should happen (policy, this
 * package) and *how* it is delivered (the worker + provider). The types here
 * describe the contract between the two: a policy produces drafts, the sweep
 * persists them, the delivery worker turns an email directive into a provider
 * call.
 */

export const TEMPLATE_NAMES = [
  'morning-brief',
  'midday-pulse',
  'evening-planning',
  'task-reminder',
  'deadline-warning',
  'task-missed',
  'plan-changed',
] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/** The three daily email slots, in chronological order. */
export const DAILY_SLOTS = ['morning', 'midday', 'evening'] as const;
export type DailySlot = (typeof DAILY_SLOTS)[number];

/** Which email leg (if any) a notification should carry. Never the rendered HTML. */
export interface EmailDirective {
  template: TemplateName;
  /** Structured, bounded template data — validated by a per-template schema. */
  data: Record<string, unknown>;
}

/**
 * What a policy decided should be announced.
 *
 * A draft is pure intent: it carries no delivery state, no provider details and
 * no credentials. `deliveryKey` is the stable idempotency key that makes
 * redelivery safe; `linkUrl` is the safe in-app deep link, built from APP_URL
 * and validated identifiers only.
 */
export interface NotificationDraft {
  type: NotificationType;
  priority: NotificationPriority;
  title: string;
  body: string;
  /** Null = deliver as soon as possible. */
  scheduledAt: Date | null;
  deliveryKey: string;
  linkUrl: string | null;
  email?: EmailDirective;
}

/** Bundle returned by the sweep so the worker can enqueue one delivery job. */
export interface PendingEmail {
  notificationId: string;
  emailLogId: string;
  userId: string;
  recipient: string;
  template: string;
  data: Record<string, unknown>;
}
