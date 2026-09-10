import { describe, expect, it } from 'vitest';

import type { ExistingSpaceItem, PlanningTask, PlanningResult, ReasonCode } from '@space/engine';
import type { DurationMinutes } from '@space/types';

import { computePlanDiff } from './diff';

const TASK = (id: string, status: string = 'PLANNED'): PlanningTask => ({
  id,
  title: `Task ${id}`,
  priority: 'NORMAL',
  status: status as PlanningTask['status'],
  estimatedMinutes: 30 as DurationMinutes,
  dueAt: null,
  scheduledStart: null,
  scheduledEnd: null,
  goalId: null,
});

const EXISTING_TASK = (
  id: string,
  startMs: number,
  endMs: number | null = startMs + 1800_000,
): ExistingSpaceItem => ({
  id: `item-${id}`,
  kind: 'TASK',
  position: 0,
  scheduledStart: new Date(startMs),
  scheduledEnd: endMs !== null ? new Date(endMs) : null,
  taskId: id,
  reminderId: null,
  calendarEventId: null,
});

const BLOCK = (
  id: string,
  startMs: number,
  endMs: number,
  reasonCode: ReasonCode = 'HARD_WORKING_HOURS',
) => ({
  kind: 'TASK' as const,
  itemId: id,
  start: new Date(startMs),
  end: new Date(endMs),
  position: 0,
  reasonCode,
});

const BASE = 1_700_000_000_000; // some fixed epoch

describe('computePlanDiff', () => {
  it('returns UNCHANGED when nothing moved', () => {
    const existing = [EXISTING_TASK('t1', BASE, BASE + 1800_000)];
    const tasks = [TASK('t1')];
    const result: PlanningResult = {
      scheduledBlocks: [BLOCK('t1', BASE, BASE + 1800_000)],
      unscheduledTasks: [],
      conflicts: [],
      explanations: [],
      proposedActions: [],
      summary: '',
      planVersion: 2,
      durationMs: 10,
    };

    const diff = computePlanDiff(existing, tasks, result);
    expect(diff.planVersion).toBe(2);
    expect(diff.hasMeaningfulChange).toBe(false);
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]!.type).toBe('UNCHANGED');
    expect(diff.entries[0]!.itemId).toBe('t1');
    expect(diff.counts.UNCHANGED).toBe(1);
  });

  it('detects MOVED when start shifts', () => {
    const existing = [EXISTING_TASK('t1', BASE, BASE + 1800_000)];
    const tasks = [TASK('t1')];
    const result: PlanningResult = {
      scheduledBlocks: [BLOCK('t1', BASE + 3600_000, BASE + 5400_000)],
      unscheduledTasks: [],
      conflicts: [],
      explanations: [],
      proposedActions: [],
      summary: '',
      planVersion: 2,
      durationMs: 10,
    };

    const diff = computePlanDiff(existing, tasks, result);
    expect(diff.hasMeaningfulChange).toBe(true);
    expect(diff.entries[0]!.type).toBe('MOVED');
    expect(diff.entries[0]!.itemId).toBe('t1');
    expect(diff.counts.MOVED).toBe(1);
  });

  it('detects COMPLETED when task is finished', () => {
    const existing = [EXISTING_TASK('t1', BASE, BASE + 1800_000)];
    const tasks = [TASK('t1', 'COMPLETED')];
    const result: PlanningResult = {
      scheduledBlocks: [],
      unscheduledTasks: [],
      conflicts: [],
      explanations: [],
      proposedActions: [],
      summary: '',
      planVersion: 2,
      durationMs: 10,
    };

    const diff = computePlanDiff(existing, tasks, result);
    expect(diff.hasMeaningfulChange).toBe(true);
    expect(diff.entries[0]!.type).toBe('COMPLETED');
    expect(diff.counts.COMPLETED).toBe(1);
  });

  it('detects REMOVED when task is cancelled', () => {
    const existing = [EXISTING_TASK('t1', BASE, BASE + 1800_000)];
    const tasks = [TASK('t1', 'CANCELLED')];
    const result: PlanningResult = {
      scheduledBlocks: [],
      unscheduledTasks: [],
      conflicts: [],
      explanations: [],
      proposedActions: [],
      summary: '',
      planVersion: 2,
      durationMs: 10,
    };

    const diff = computePlanDiff(existing, tasks, result);
    expect(diff.hasMeaningfulChange).toBe(true);
    expect(diff.entries[0]!.type).toBe('REMOVED');
    expect(diff.counts.REMOVED).toBe(1);
  });

  it('detects UNSCHEDULED when task has no block', () => {
    const existing = [EXISTING_TASK('t1', BASE, BASE + 1800_000)];
    const tasks = [TASK('t1')];
    const result: PlanningResult = {
      scheduledBlocks: [],
      unscheduledTasks: [{ taskId: 't1', reasonCode: 'HARD_WORKING_HOURS', message: 'No room' }],
      conflicts: [],
      explanations: [],
      proposedActions: [],
      summary: '',
      planVersion: 2,
      durationMs: 10,
    };

    const diff = computePlanDiff(existing, tasks, result);
    expect(diff.hasMeaningfulChange).toBe(true);
    expect(diff.entries[0]!.type).toBe('UNSCHEDULED');
    expect(diff.entries[0]!.engineReasonCode).toBe('HARD_WORKING_HOURS');
    expect(diff.counts.UNSCHEDULED).toBe(1);
  });

  it('detects ADDED when a new task is placed', () => {
    const existing: ExistingSpaceItem[] = [];
    const tasks = [TASK('t1')];
    const result: PlanningResult = {
      scheduledBlocks: [BLOCK('t1', BASE, BASE + 1800_000)],
      unscheduledTasks: [],
      conflicts: [],
      explanations: [],
      proposedActions: [],
      summary: '',
      planVersion: 2,
      durationMs: 10,
    };

    const diff = computePlanDiff(existing, tasks, result);
    expect(diff.hasMeaningfulChange).toBe(true);
    expect(diff.entries[0]!.type).toBe('ADDED');
    expect(diff.entries[0]!.itemId).toBe('t1');
    expect(diff.counts.ADDED).toBe(1);
  });

  it('skips CALENDAR_EVENT blocks in ADDED detection', () => {
    const existing: ExistingSpaceItem[] = [];
    const tasks: PlanningTask[] = [];
    const result: PlanningResult = {
      scheduledBlocks: [
        {
          kind: 'CALENDAR_EVENT',
          itemId: 'cal1',
          start: new Date(BASE),
          end: new Date(BASE + 3600_000),
          position: 0,
          reasonCode: 'HARD_WORKING_HOURS',
        },
      ],
      unscheduledTasks: [],
      conflicts: [],
      explanations: [],
      proposedActions: [],
      summary: '',
      planVersion: 2,
      durationMs: 10,
    };

    const diff = computePlanDiff(existing, tasks, result);
    expect(diff.hasMeaningfulChange).toBe(false);
    expect(diff.entries).toHaveLength(0);
  });

  it('produces a mixed diff with multiple change types', () => {
    const existing = [
      EXISTING_TASK('t1', BASE, BASE + 1800_000),
      EXISTING_TASK('t2', BASE + 1800_000, BASE + 3600_000),
      EXISTING_TASK('t3', BASE + 3600_000, BASE + 5400_000),
    ];
    const tasks = [TASK('t1', 'COMPLETED'), TASK('t2'), TASK('t3'), TASK('t4')];
    const result: PlanningResult = {
      scheduledBlocks: [
        BLOCK('t2', BASE, BASE + 1800_000), // moved
        BLOCK('t4', BASE + 1800_000, BASE + 3600_000), // added
      ],
      unscheduledTasks: [
        { taskId: 't3', reasonCode: 'HARD_DEADLINE_CONFLICT', message: 'Too tight' },
      ],
      conflicts: [],
      explanations: [],
      proposedActions: [],
      summary: '',
      planVersion: 3,
      durationMs: 10,
    };

    const diff = computePlanDiff(existing, tasks, result);
    expect(diff.planVersion).toBe(3);
    expect(diff.hasMeaningfulChange).toBe(true);
    expect(diff.counts.COMPLETED).toBe(1);
    expect(diff.counts.MOVED).toBe(1);
    expect(diff.counts.UNSCHEDULED).toBe(1);
    expect(diff.counts.ADDED).toBe(1);
    expect(diff.entries).toHaveLength(4);
  });
});
