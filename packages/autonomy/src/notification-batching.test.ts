import { describe, expect, it } from 'vitest';

import type { CalendarDate } from '@space/types';

import {
  createNotificationBatch,
  summarizeBatch,
  batchTitle,
  mergeBatches,
} from './notification-batching';
import type { ChangeClassification, NotificationBatch, NotificationBatchEntry } from './types';

const ENTRY: NotificationBatchEntry = {
  reasonCode: 'TASK_CHANGED',
  message: 'Task was updated',
  classification: 'REPLAN_REQUIRED',
};

const makeEntries = (count: number): NotificationBatchEntry[] =>
  Array.from({ length: count }, () => ENTRY);

const DATE = '2026-09-10' as CalendarDate;
const ASSEMBLED = new Date('2026-09-10T08:00:00Z');

describe('createNotificationBatch', () => {
  it('sets maxPriority matching a single entry classification', () => {
    const batch = createNotificationBatch(
      [{ ...ENTRY, classification: 'REVIEW_ONLY' }],
      'u1',
      's1',
      DATE,
      ASSEMBLED,
    );
    expect(batch.maxPriority).toBe('REVIEW_ONLY');
    expect(batch.changes).toHaveLength(1);
  });

  it('picks the highest priority among multiple entries', () => {
    const batch = createNotificationBatch(
      [
        { ...ENTRY, classification: 'NORMAL' as ChangeClassification },
        { ...ENTRY, classification: 'REPLAN_REQUIRED' },
        { ...ENTRY, classification: 'URGENT_REPLAN' },
      ],
      'u1',
      's1',
      DATE,
      ASSEMBLED,
    );
    expect(batch.maxPriority).toBe('URGENT_REPLAN');
  });

  it('returns an empty changes array when entries are empty', () => {
    const batch = createNotificationBatch([], 'u1', 's1', DATE, ASSEMBLED);
    expect(batch.changes).toHaveLength(0);
    expect(batch.maxPriority).toBe('NO_REPLAN');
  });

  it('truncates to MAX_BATCH_ENTRIES (20)', () => {
    const batch = createNotificationBatch(makeEntries(25), 'u1', 's1', DATE, ASSEMBLED);
    expect(batch.changes).toHaveLength(20);
  });
});

describe('summarizeBatch', () => {
  it('returns "No changes detected." for empty changes', () => {
    const batch = createNotificationBatch([], 'u1', 's1', DATE, ASSEMBLED);
    expect(summarizeBatch(batch)).toBe('No changes detected.');
  });

  it('returns the single change message for one entry', () => {
    const batch = createNotificationBatch(
      [{ ...ENTRY, message: 'Custom message here' }],
      'u1',
      's1',
      DATE,
      ASSEMBLED,
    );
    expect(summarizeBatch(batch)).toBe('Custom message here');
  });

  it('returns a grouped summary for multiple changes', () => {
    const batch = createNotificationBatch(
      [
        { ...ENTRY, reasonCode: 'TASK_CHANGED', message: 'Task update' },
        { ...ENTRY, reasonCode: 'TASK_CHANGED', message: 'Task update' },
        { ...ENTRY, reasonCode: 'CALENDAR_CHANGED', message: 'Cal change' },
      ],
      'u1',
      's1',
      DATE,
      ASSEMBLED,
    );
    const summary = summarizeBatch(batch);
    expect(summary).toContain('Plan updated:');
    expect(summary).toContain('2');
  });
});

describe('batchTitle', () => {
  it('returns "Urgent: ..." for URGENT_REPLAN priority', () => {
    const batch = createNotificationBatch(
      [{ ...ENTRY, classification: 'URGENT_REPLAN' }],
      'u1',
      's1',
      DATE,
      ASSEMBLED,
    );
    expect(batchTitle(batch)).toContain('Urgent');
  });

  it('returns "Plan for ... updated" for REPLAN_REQUIRED', () => {
    const batch = createNotificationBatch(
      [{ ...ENTRY, classification: 'REPLAN_REQUIRED' }],
      'u1',
      's1',
      DATE,
      ASSEMBLED,
    );
    expect(batchTitle(batch)).toBe('Plan for 2026-09-10 updated');
  });
});

describe('mergeBatches', () => {
  const batchA: NotificationBatch = {
    userId: 'u1',
    spaceId: 's1',
    date: DATE,
    changes: [{ ...ENTRY, reasonCode: 'TASK_CHANGED', message: 'Change A' }],
    maxPriority: 'REPLAN_REQUIRED',
    assembledAt: ASSEMBLED,
  };

  const batchB: NotificationBatch = {
    userId: 'u1',
    spaceId: 's1',
    date: DATE,
    changes: [{ ...ENTRY, reasonCode: 'CALENDAR_CHANGED', message: 'Change B' }],
    maxPriority: 'URGENT_REPLAN',
    assembledAt: new Date('2026-09-10T08:05:00Z'),
  };

  it('merges changes when userId and spaceId match', () => {
    const merged = mergeBatches(batchA, batchB);
    expect(merged.changes).toHaveLength(2);
    expect(merged.userId).toBe('u1');
    expect(merged.spaceId).toBe('s1');
  });

  it('returns the later batch when userId differs', () => {
    const differentUser: NotificationBatch = {
      ...batchB,
      userId: 'u2',
    };
    const merged = mergeBatches(batchA, differentUser);
    expect(merged).toBe(differentUser);
  });

  it('returns the later batch when spaceId differs', () => {
    const differentSpace: NotificationBatch = {
      ...batchB,
      spaceId: 's2',
    };
    const merged = mergeBatches(batchA, differentSpace);
    expect(merged).toBe(differentSpace);
  });
});
