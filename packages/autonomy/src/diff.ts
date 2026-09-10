import type {
  ExistingSpaceItem,
  PlanningResult,
  PlanningTask,
  ScheduledBlock,
  UnscheduledTask,
} from '@space/engine';

import type { PlanDiff, PlanDiffEntry, PlanDiffReasonCode, PlanDiffType } from './types';

/**
 * Deterministic plan diff.
 *
 * Compares the day's timeline *before* a planning pass (the persisted SpaceItem
 * rows the snapshot loaded) with the blocks the pass produced *after*, naming
 * every changed item and what kind of change it was. Sixty identical inputs
 * produce sixty identical diffs — there is no ordering, timestamp or random
 * input here.
 *
 * The five non-UNCHANGED types map to the five ways a day can move:
 *   ADDED        — work the new plan placed that was not on the day before.
 *   MOVED        — work that stayed but shifted within the day.
 *   UNSCHEDULED  — work that fell off the day while still open.
 *   COMPLETED    — work that left the day because the user finished it.
 *   REMOVED      — work that left the day for any other reason (cancelled,
 *                  reminder cleared).
 * Calendar events are never diffed: they are anchors, and neither the engine
 * nor the persister moves them.
 */
export const computePlanDiff = (
  existingItems: readonly ExistingSpaceItem[],
  tasks: readonly PlanningTask[],
  result: PlanningResult,
): PlanDiff => {
  const existing = existingItems.filter((item) => item.kind === 'TASK' || item.kind === 'REMINDER');

  const existingKeyed = new Map<string, ExistingSpaceItem>();
  for (const item of existing) {
    const itemId = item.taskId ?? item.reminderId ?? item.calendarEventId;
    if (itemId) {
      existingKeyed.set(itemId, item);
    }
  }

  const blocks = new Map<string, ScheduledBlock>();
  for (const block of result.scheduledBlocks) {
    if (block.kind === 'CALENDAR_EVENT') {
      continue;
    }
    blocks.set(block.itemId, block);
  }

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const unscheduledByTaskId = new Map(result.unscheduledTasks.map((task) => [task.taskId, task]));

  const entries: PlanDiffEntry[] = [];
  const seen = new Set<string>();

  const push = (
    type: PlanDiffType,
    reasonCode: PlanDiffReasonCode,
    item: { itemId: string; kind: 'TASK' | 'REMINDER' },
    engineReasonCode: PlanDiffEntry['engineReasonCode'],
    message: string,
    previous?: PlanDiffEntry['previous'],
    next?: PlanDiffEntry['next'],
  ) => {
    entries.push({
      type,
      itemId: item.itemId,
      kind: item.kind,
      reasonCode,
      engineReasonCode,
      message,
      previous,
      next,
    });
  };

  // 1. Items that were on the day before the pass.
  for (const itemId of [...existingKeyed.keys()].sort()) {
    const item = existingKeyed.get(itemId);
    // `existing` guarantees item is a TASK/REMINDER row, so itemId is set.
    const kind = item?.kind as 'TASK' | 'REMINDER';
    const key = `${kind}:${itemId}`;
    seen.add(key);

    const block = blocks.get(itemId);
    const task = tasksById.get(itemId);
    const unscheduled: UnscheduledTask | undefined = unscheduledByTaskId.get(itemId);

    const previous = {
      start: item?.scheduledStart?.getTime() ?? 0,
      end: item?.scheduledEnd?.getTime() ?? null,
    };
    const next = block ? { start: block.start.getTime(), end: block.end.getTime() } : null;

    if (!block) {
      if (kind === 'TASK' && task?.status === 'COMPLETED') {
        push(
          'COMPLETED',
          'PLAN_DIFF_COMPLETED',
          { itemId, kind },
          undefined,
          'Completed — the freed window was reused.',
          previous,
          next,
        );
        continue;
      }
      if (task?.status === 'CANCELLED') {
        push(
          'REMOVED',
          'PLAN_DIFF_REMOVED',
          { itemId, kind },
          undefined,
          'Work was cancelled.',
          previous,
          next,
        );
        continue;
      }
      if (kind === 'REMINDER') {
        push(
          'REMOVED',
          'PLAN_DIFF_REMOVED',
          { itemId, kind },
          undefined,
          'The reminder is no longer on the day.',
          previous,
          next,
        );
        continue;
      }
      push(
        'UNSCHEDULED',
        'PLAN_DIFF_UNSCHEDULED',
        { itemId, kind },
        unscheduled?.reasonCode,
        unscheduled?.message ?? 'Could not be placed.',
        previous,
        next,
      );
      continue;
    }

    // Reminders are instants (the engine places a start; the SpaceItem row keeps
    // `scheduledEnd` null), so only their start participates in "moved".
    if (next === null) {
      continue;
    }
    const same =
      kind === 'REMINDER'
        ? previous.start === next.start
        : previous.start === next.start && previous.end === next.end;

    if (same) {
      push(
        'UNCHANGED',
        'PLAN_DIFF_UNCHANGED',
        { itemId, kind },
        block.reasonCode,
        'Unchanged.',
        previous,
        next,
      );
    } else {
      push(
        'MOVED',
        'PLAN_DIFF_MOVED',
        { itemId, kind },
        block.reasonCode,
        `Moved from ${iso(previous.start)} to ${iso(next.start)}.`,
        previous,
        next,
      );
    }
  }

  // 2. Items the pass placed that were not on the day before.
  for (const [itemId, block] of [...blocks.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const key = `${block.kind}:${itemId}`;
    if (seen.has(key)) {
      continue;
    }
    const task = tasksById.get(itemId);
    const kind = block.kind as 'TASK' | 'REMINDER';
    push(
      'ADDED',
      'PLAN_DIFF_ADDED',
      { itemId, kind },
      block.reasonCode,
      `Placed at ${iso(block.start.getTime())}${task?.title ? ` — ${task.title}` : ''}.`,
      null,
      { start: block.start.getTime(), end: block.end.getTime() },
    );
  }

  const counts: PlanDiff['counts'] = {
    UNCHANGED: 0,
    ADDED: 0,
    MOVED: 0,
    REMOVED: 0,
    UNSCHEDULED: 0,
    COMPLETED: 0,
  };
  for (const entry of entries) {
    counts[entry.type] += 1;
  }

  entries.sort((a, b) => {
    const order: Record<PlanDiffType, number> = {
      ADDED: 0,
      MOVED: 1,
      UNSCHEDULED: 2,
      COMPLETED: 3,
      REMOVED: 4,
      UNCHANGED: 5,
    };
    return order[a.type] - order[b.type] || a.itemId.localeCompare(b.itemId);
  });

  return {
    planVersion: result.planVersion,
    entries,
    counts,
    hasMeaningfulChange:
      counts.ADDED + counts.MOVED + counts.REMOVED + counts.UNSCHEDULED + counts.COMPLETED > 0,
  };
};

const iso = (epochMs: number): string => {
  // Locale-independent, stable: the instant rendered as UTC so any two replays
  // of the same pass print identical strings.
  return new Date(epochMs).toISOString().slice(11, 16);
};
