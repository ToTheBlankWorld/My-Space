import type { EventType } from '@space/types';

import type { TriggerNode } from './types';

/**
 * Deterministic trigger graph.
 *
 * Every EventType the system produces maps to exactly one TriggerNode that
 * describes how the autonomous loop should handle it. The mapping is total:
 * any event type not listed returns a conservative DEFAULT node (NO_REPLAN,
 * no notification, no replan), so a newer producer can never break an older
 * loop.
 *
 * This module is pure — it never touches the database, a clock, or a user.
 */

const TRIGGER_NODES: ReadonlyMap<EventType, TriggerNode> = new Map<EventType, TriggerNode>([
  // ---- Task lifecycle ----
  [
    'TASK_CREATED',
    {
      eventType: 'TASK_CREATED',
      baseClassification: 'REPLAN_REQUIRED',
      reasonCode: 'TASK_CHANGED',
      resolutionStrategy: 'EVENT_DATE',
      requiresReplan: true,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'TASK_UPDATED',
    {
      eventType: 'TASK_UPDATED',
      baseClassification: 'REPLAN_REQUIRED',
      reasonCode: 'TASK_CHANGED',
      resolutionStrategy: 'EVENT_DATE',
      requiresReplan: true,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'TASK_COMPLETED',
    {
      eventType: 'TASK_COMPLETED',
      baseClassification: 'REPLAN_REQUIRED',
      reasonCode: 'TASK_COMPLETED',
      resolutionStrategy: 'EVENT_DATE',
      requiresReplan: true,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'TASK_MISSED',
    {
      eventType: 'TASK_MISSED',
      baseClassification: 'REVIEW_ONLY',
      reasonCode: 'TASK_MISSED_ELAPSED',
      resolutionStrategy: 'EVENT_DATE',
      requiresReplan: false,
      requiresNotification: true,
      notificationPriority: 'REVIEW_ONLY',
    },
  ],
  [
    'TASK_RESCHEDULED',
    {
      eventType: 'TASK_RESCHEDULED',
      baseClassification: 'REPLAN_REQUIRED',
      reasonCode: 'TASK_CHANGED',
      resolutionStrategy: 'EVENT_DATE',
      requiresReplan: true,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],

  // ---- Calendar lifecycle ----
  [
    'CALENDAR_CHANGED',
    {
      eventType: 'CALENDAR_CHANGED',
      baseClassification: 'REPLAN_REQUIRED',
      reasonCode: 'CALENDAR_CHANGED',
      resolutionStrategy: 'CALENDAR_SYNC',
      requiresReplan: true,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'CALENDAR_SYNCED',
    {
      eventType: 'CALENDAR_SYNCED',
      baseClassification: 'REPLAN_REQUIRED',
      reasonCode: 'CALENDAR_CHANGED',
      resolutionStrategy: 'CALENDAR_SYNC',
      requiresReplan: true,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'CALENDAR_CONNECTED',
    {
      eventType: 'CALENDAR_CONNECTED',
      baseClassification: 'REVIEW_ONLY',
      reasonCode: 'REVIEW_ONLY',
      resolutionStrategy: 'USER_SCOPE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'CALENDAR_DISCONNECTED',
    {
      eventType: 'CALENDAR_DISCONNECTED',
      baseClassification: 'REVIEW_ONLY',
      reasonCode: 'REVIEW_ONLY',
      resolutionStrategy: 'USER_SCOPE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'CALENDAR_SYNC_FAILED',
    {
      eventType: 'CALENDAR_SYNC_FAILED',
      baseClassification: 'REVIEW_ONLY',
      reasonCode: 'REVIEW_ONLY',
      resolutionStrategy: 'USER_SCOPE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],

  // ---- Reminder lifecycle ----
  [
    'REMINDER_CREATED',
    {
      eventType: 'REMINDER_CREATED',
      baseClassification: 'REVIEW_ONLY',
      reasonCode: 'REVIEW_ONLY',
      resolutionStrategy: 'EVENT_DATE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'REMINDER_TRIGGERED',
    {
      eventType: 'REMINDER_TRIGGERED',
      baseClassification: 'REVIEW_ONLY',
      reasonCode: 'REVIEW_ONLY',
      resolutionStrategy: 'EVENT_DATE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'REMINDER_SKIPPED',
    {
      eventType: 'REMINDER_SKIPPED',
      baseClassification: 'NO_REPLAN',
      reasonCode: 'NO_CHANGE',
      resolutionStrategy: 'EVENT_DATE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],

  // ---- Planning lifecycle ----
  [
    'PLANNING_STARTED',
    {
      eventType: 'PLANNING_STARTED',
      baseClassification: 'NO_REPLAN',
      reasonCode: 'NO_CHANGE',
      resolutionStrategy: 'EVENT_DATE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'PLANNING_COMPLETED',
    {
      eventType: 'PLANNING_COMPLETED',
      baseClassification: 'NO_REPLAN',
      reasonCode: 'PLANNING_COMPLETED',
      resolutionStrategy: 'EVENT_DATE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'PLANNING_FAILED',
    {
      eventType: 'PLANNING_FAILED',
      baseClassification: 'REVIEW_ONLY',
      reasonCode: 'REVIEW_ONLY',
      resolutionStrategy: 'EVENT_DATE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],

  // ---- Space lifecycle ----
  [
    'SPACE_CREATED',
    {
      eventType: 'SPACE_CREATED',
      baseClassification: 'NO_REPLAN',
      reasonCode: 'NO_CHANGE',
      resolutionStrategy: 'EVENT_DATE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'SPACE_UPDATED',
    {
      eventType: 'SPACE_UPDATED',
      baseClassification: 'NO_REPLAN',
      reasonCode: 'NO_CHANGE',
      resolutionStrategy: 'EVENT_DATE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'SPACE_OPTIMIZED',
    {
      eventType: 'SPACE_OPTIMIZED',
      baseClassification: 'NO_REPLAN',
      reasonCode: 'NO_CHANGE',
      resolutionStrategy: 'EVENT_DATE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],

  // ---- Deadlines ----
  [
    'DEADLINE_APPROACHING',
    {
      eventType: 'DEADLINE_APPROACHING',
      baseClassification: 'NO_REPLAN',
      reasonCode: 'NO_CHANGE',
      resolutionStrategy: 'DEADLINE_SCAN',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],

  // ---- Goals ----
  [
    'GOAL_CREATED',
    {
      eventType: 'GOAL_CREATED',
      baseClassification: 'NO_REPLAN',
      reasonCode: 'NO_CHANGE',
      resolutionStrategy: 'USER_SCOPE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'GOAL_ACHIEVED',
    {
      eventType: 'GOAL_ACHIEVED',
      baseClassification: 'NO_REPLAN',
      reasonCode: 'NO_CHANGE',
      resolutionStrategy: 'USER_SCOPE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],

  // ---- Notifications ----
  [
    'NOTIFICATION_CREATED',
    {
      eventType: 'NOTIFICATION_CREATED',
      baseClassification: 'NO_REPLAN',
      reasonCode: 'NO_CHANGE',
      resolutionStrategy: 'USER_SCOPE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'NOTIFICATION_QUEUED',
    {
      eventType: 'NOTIFICATION_QUEUED',
      baseClassification: 'NO_REPLAN',
      reasonCode: 'NO_CHANGE',
      resolutionStrategy: 'USER_SCOPE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'NOTIFICATION_SENT',
    {
      eventType: 'NOTIFICATION_SENT',
      baseClassification: 'NO_REPLAN',
      reasonCode: 'NO_CHANGE',
      resolutionStrategy: 'USER_SCOPE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
  [
    'NOTIFICATION_FAILED',
    {
      eventType: 'NOTIFICATION_FAILED',
      baseClassification: 'NO_REPLAN',
      reasonCode: 'NO_CHANGE',
      resolutionStrategy: 'USER_SCOPE',
      requiresReplan: false,
      requiresNotification: false,
      notificationPriority: 'NO_REPLAN',
    },
  ],
]);

/**
 * The fallback node for event types the graph does not know about.
 * Conservative: no replan, no notification.
 */
const DEFAULT_NODE: TriggerNode = {
  eventType: 'SPACE_CREATED',
  baseClassification: 'NO_REPLAN',
  reasonCode: 'NO_CHANGE',
  resolutionStrategy: 'USER_SCOPE',
  requiresReplan: false,
  requiresNotification: false,
  notificationPriority: 'NO_REPLAN',
};

/**
 * Looks up the trigger node for an event type.
 * Returns the default node for unknown types (forward-compatible).
 */
export const resolveTriggerNode = (eventType: string): TriggerNode => {
  const node = TRIGGER_NODES.get(eventType as EventType);
  return node ?? { ...DEFAULT_NODE, eventType: eventType as EventType };
};

/**
 * All registered trigger nodes, keyed by event type.
 * Useful for testing and documentation generation.
 */
export const allTriggerNodes = (): ReadonlyMap<EventType, TriggerNode> => TRIGGER_NODES;

/**
 * The set of event types that require replanning when observed.
 */
export const REPLAN_EVENT_TYPES: ReadonlySet<EventType> = new Set(
  [...TRIGGER_NODES.values()].filter((n) => n.requiresReplan).map((n) => n.eventType),
);

/**
 * The set of event types that should produce a notification.
 */
export const NOTIFICATION_EVENT_TYPES: ReadonlySet<EventType> = new Set(
  [...TRIGGER_NODES.values()].filter((n) => n.requiresNotification).map((n) => n.eventType),
);
