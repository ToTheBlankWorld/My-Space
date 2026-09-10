import type { CalendarDate } from '@space/types';
import type {
  ChangeClassification,
  ChangeReasonCode,
  NotificationBatch,
  NotificationBatchEntry,
} from './types';

/**
 * Notification batching.
 *
 * When multiple changes occur within a coalescing window for the same Space,
 * they are grouped into a single notification rather than sending one per
 * change. This prevents notification spam while still conveying the essential
 * information.
 *
 * The batcher is pure: it takes a list of entries and returns a single
 * NotificationBatch. No database access, no clock, no side effects.
 */

/** Maximum number of changes in a single batch before truncation. */
const MAX_BATCH_ENTRIES = 20;

/**
 * Groups multiple notification entries into a single batch.
 *
 * Entries with the same userId, spaceId, and date are combined. The batch's
 * priority is the highest priority of any entry in the batch.
 */
export const createNotificationBatch = (
  entries: NotificationBatchEntry[],
  userId: string,
  spaceId: string,
  date: CalendarDate,
  assembledAt: Date,
): NotificationBatch => {
  const truncated = entries.slice(0, MAX_BATCH_ENTRIES);

  const classificationRank: Record<ChangeClassification, number> = {
    NO_REPLAN: 0,
    REVIEW_ONLY: 1,
    REPLAN_REQUIRED: 2,
    URGENT_REPLAN: 3,
  };

  let maxPriority: ChangeClassification = 'NO_REPLAN';
  let maxRank = 0;
  for (const entry of truncated) {
    const rank = classificationRank[entry.classification];
    if (rank > maxRank) {
      maxRank = rank;
      maxPriority = entry.classification;
    }
  }

  return {
    userId,
    spaceId,
    date,
    changes: truncated,
    maxPriority,
    assembledAt,
  };
};

/**
 * Generates a human-readable summary of a notification batch.
 *
 * Used by the notification policy to construct the notification body.
 */
export const summarizeBatch = (batch: NotificationBatch): string => {
  if (batch.changes.length === 0) return 'No changes detected.';
  if (batch.changes.length === 1) return batch.changes[0]?.message ?? 'No changes detected.';

  const byReason = new Map<ChangeReasonCode, number>();
  for (const change of batch.changes) {
    byReason.set(change.reasonCode, (byReason.get(change.reasonCode) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const [reasonCode, count] of byReason) {
    const label = reasonCodeToLabel(reasonCode);
    parts.push(`${count} ${label}${count === 1 ? '' : ''}`);
  }

  return `Plan updated: ${parts.join(', ')}.`;
};

/**
 * Generates a notification title for a batch based on its priority.
 */
export const batchTitle = (batch: NotificationBatch): string => {
  const date = batch.date;
  switch (batch.maxPriority) {
    case 'URGENT_REPLAN':
      return `Urgent: plan for ${date} needs immediate attention`;
    case 'REPLAN_REQUIRED':
      return `Plan for ${date} updated`;
    case 'REVIEW_ONLY':
      return `Plan review for ${date}`;
    default:
      return `Plan for ${date} reviewed`;
  }
};

/**
 * Merges two batches for the same Space if they are within the coalescing
 * window. Returns the merged batch, or the later one if they cannot be merged.
 */
export const mergeBatches = (
  earlier: NotificationBatch,
  later: NotificationBatch,
): NotificationBatch => {
  if (earlier.userId !== later.userId || earlier.spaceId !== later.spaceId) {
    return later;
  }

  const mergedEntries = [...earlier.changes, ...later.changes];
  return createNotificationBatch(
    mergedEntries,
    later.userId,
    later.spaceId,
    later.date,
    later.assembledAt,
  );
};

const reasonCodeToLabel = (code: ChangeReasonCode): string => {
  switch (code) {
    case 'CALENDAR_CHANGED':
      return 'calendar change';
    case 'DEADLINE_IMPENDING':
      return 'deadline approaching';
    case 'DEADLINE_IMPOSSIBLE':
      return 'deadline at risk';
    case 'DEADLINE_ELAPSED':
      return 'overdue deadline';
    case 'TASK_CHANGED':
      return 'task update';
    case 'TASK_COMPLETED':
      return 'task completion';
    case 'TASK_MISSED_ELAPSED':
      return 'missed task';
    case 'TASK_OVERDUE':
      return 'overdue task';
    case 'PLANNING_COMPLETED':
      return 'planning pass';
    case 'TOMORROW_UNPLANNED':
      return 'unplanned tomorrow';
    case 'REVIEW_ONLY':
      return 'review';
    case 'NO_CHANGE':
      return 'no change';
    default:
      return 'change';
  }
};
