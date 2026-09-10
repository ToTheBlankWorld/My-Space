import type { PlanningInput, PlanningConflict, ScheduledBlock } from './types';

/**
 * Conflict detection and resolution.
 *
 * After initial scheduling, this module scans for overlaps between:
 *   - Scheduled tasks and calendar events
 *   - Scheduled tasks and each other
 *   - Tasks outside working hours
 *
 * Resolution is deterministic: the lower-priority item is displaced first.
 * If priorities are equal, the later-starting item is displaced.
 * Displaced items become unscheduled with a CONFLICT_RESOLVED reason.
 *
 * Pure function: no side effects.
 */
export const detectAndResolveConflicts = (
  blocks: readonly ScheduledBlock[],
  input: PlanningInput,
): {
  resolved: ScheduledBlock[];
  conflicts: PlanningConflict[];
  displaced: string[];
} => {
  const conflicts: PlanningConflict[] = [];
  const displaced = new Set<string>();
  const resolved: ScheduledBlock[] = [...blocks];

  // 1. Task-task overlaps.
  for (let i = 0; i < resolved.length; i += 1) {
    if (displaced.has(resolved[i]!.itemId)) continue;

    for (let j = i + 1; j < resolved.length; j += 1) {
      if (displaced.has(resolved[j]!.itemId)) continue;

      const a = resolved[i]!;
      const b = resolved[j]!;

      if (blocksOverlap(a.start, a.end, b.start, b.end)) {
        const loser = resolveByPriority(a, b, input);
        displaced.add(loser.itemId);

        conflicts.push({
          type: 'TASK_TASK_OVERLAP',
          itemIds: [a.itemId, b.itemId],
          description: `"${getItemTitle(a.itemId, input)}" overlaps with "${getItemTitle(b.itemId, input)}".`,
          resolution: `Displaced "${getItemTitle(loser.itemId, input)}" due to lower priority.`,
          reasonCode: 'CONFLICT_RESOLVED_BY_PRIORITY',
        });
      }
    }
  }

  // 2. Task-calendar overlaps.
  for (const block of resolved) {
    if (displaced.has(block.itemId)) continue;

    for (const event of input.calendarEvents) {
      if (event.status === 'CANCELLED') continue;

      if (blocksOverlap(block.start, block.end, event.startAt, event.endAt)) {
        displaced.add(block.itemId);

        conflicts.push({
          type: 'TASK_CALENDAR_OVERLAP',
          itemIds: [block.itemId, event.id],
          description: `"${getItemTitle(block.itemId, input)}" overlaps with calendar event "${event.title}".`,
          resolution: `Task displaced to respect calendar commitment.`,
          reasonCode: 'CONFLICT_RESOLVED_BY_DELEGATION',
        });
      }
    }
  }

  // 3. Tasks outside working hours.
  for (const block of resolved) {
    if (displaced.has(block.itemId)) continue;

    if (!isWithinWorkingHours(block.start, block.end, input)) {
      displaced.add(block.itemId);

      conflicts.push({
        type: 'TASK_OUTSIDE_WORKING_HOURS',
        itemIds: [block.itemId],
        description: `"${getItemTitle(block.itemId, input)}" is scheduled outside working hours.`,
        resolution: `Task displaced from outside working hours.`,
        reasonCode: 'HARD_WORKING_HOURS',
      });
    }
  }

  // Filter out displaced blocks.
  const finalBlocks = resolved.filter((b) => !displaced.has(b.itemId));

  return { resolved: finalBlocks, conflicts, displaced: [...displaced] };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const blocksOverlap = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean => {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
};

const resolveByPriority = (
  a: ScheduledBlock,
  b: ScheduledBlock,
  input: PlanningInput,
): ScheduledBlock => {
  const taskA = input.tasks.find((t) => t.id === a.itemId);
  const taskB = input.tasks.find((t) => t.id === b.itemId);

  const prioA = taskA ? priorityOrdinal(taskA.priority) : 2;
  const prioB = taskB ? priorityOrdinal(taskB.priority) : 2;

  if (prioA !== prioB) {
    // Higher priority (lower ordinal) wins.
    return prioA < prioB ? b : a;
  }

  // Equal priority: later start loses.
  return a.start.getTime() <= b.start.getTime() ? b : a;
};

const priorityOrdinal = (priority: string): number => {
  switch (priority) {
    case 'CRITICAL':
      return 0;
    case 'HIGH':
      return 1;
    case 'NORMAL':
      return 2;
    case 'LOW':
      return 3;
    default:
      return 2;
  }
};

const getItemTitle = (itemId: string, input: PlanningInput): string => {
  const task = input.tasks.find((t) => t.id === itemId);
  if (task) return task.title;

  const event = input.calendarEvents.find((e) => e.id === itemId);
  if (event) return event.title;

  const reminder = input.reminders.find((r) => r.id === itemId);
  if (reminder) return reminder.title;

  return itemId;
};

const isWithinWorkingHours = (start: Date, end: Date, input: PlanningInput): boolean => {
  const targetWeekday = getWeekdayFromDate(input.date);
  const dayBlocks = input.workingHours.filter((wh) => wh.weekday === targetWeekday);

  if (dayBlocks.length === 0) return false;

  for (const wh of dayBlocks) {
    const whStart = minuteOfDayToDate(input.date, wh.startMinute);
    const whEnd = minuteOfDayToDate(input.date, wh.endMinute);

    if (start.getTime() >= whStart.getTime() && end.getTime() <= whEnd.getTime()) {
      return true;
    }
  }

  return false;
};

const getWeekdayFromDate = (date: string): string => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const d = new Date(Date.UTC(year, month - 1, day));
  const names = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  return names[d.getUTCDay()]!;
};

const minuteOfDayToDate = (date: string, minuteOfDay: number): Date => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return new Date(Date.UTC(year, month - 1, day, hours, minutes));
};
