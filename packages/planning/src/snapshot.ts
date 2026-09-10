import type { Database } from '@space/database';
import type { PlanningInput, PlanningCalendarEvent, PlanningReminder } from '@space/engine';
import type { Logger } from '@space/logger';
import { calendarDateRange } from '@space/time';
import type { CalendarDate, DurationMinutes, TimeZone } from '@space/types';
import { durationMinutesSchema, timeZoneSchema } from '@space/validation';

/**
 * Loads the immutable snapshot one planning pass runs against.
 *
 * The snapshot is the entire input contract of the deterministic engine. Two
 * passes loaded from identical database state produce identical plans, which is
 * exactly what makes a retry safe and a user-triggered re-plan predictable.
 */

export interface LoadPlanningInputArgs {
  userId: string;
  date: CalendarDate;
  spaceId: string;
  space: PlanningInput['space'];
  maxTasksPerPlan: number;
}

const minutes = (value: number | null): DurationMinutes | null =>
  value === null ? null : durationMinutesSchema.parse(value);

export const loadTimeZone = async (db: Database, userId: string): Promise<string> => {
  const preferences = await db.userPreferences.findUnique({ where: { userId } });
  return preferences?.timeZone ?? 'UTC';
};

export const dedupeById = <T extends { id: string }>(rows: readonly T[]): T[] => {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    unique.push(row);
  }
  return unique;
};

export const loadPlanningInput = async (
  db: Database,
  logger: Logger,
  args: LoadPlanningInputArgs,
): Promise<PlanningInput> => {
  const { userId, date, spaceId, space, maxTasksPerPlan } = args;
  const timeZone: TimeZone = timeZoneSchema.parse(await loadTimeZone(db, userId));
  const range = calendarDateRange(date, timeZone);

  const planningPreferences = await db.planningPreferences.findUnique({
    where: { userId },
  });

  const existingItems = await db.spaceItem.findMany({
    where: { spaceId, userId },
    select: {
      id: true,
      kind: true,
      position: true,
      scheduledStart: true,
      scheduledEnd: true,
      taskId: true,
      reminderId: true,
      calendarEventId: true,
    },
  });

  // The candidate pool: the space's own tasks, anything already scheduled into
  // the day, and anything due during the day (deadline pull-in).
  const tasks = await db.task.findMany({
    where: {
      userId,
      OR: [
        { spaceId },
        { scheduledStart: { gte: range.start, lt: range.end } },
        { dueAt: { gte: range.start, lt: range.end } },
      ],
      status: { in: ['INBOX', 'PLANNED', 'IN_PROGRESS'] },
    },
    select: {
      id: true,
      title: true,
      priority: true,
      status: true,
      estimatedMinutes: true,
      dueAt: true,
      scheduledStart: true,
      scheduledEnd: true,
      goalId: true,
    },
  });

  const uniqueTasks = dedupeById(tasks);

  if (uniqueTasks.length > maxTasksPerPlan) {
    throw new Error(
      `planning input has ${uniqueTasks.length} tasks; the cap is ${maxTasksPerPlan}`,
    );
  }

  const taskIds = uniqueTasks.map((task) => task.id);
  const [dependencies, calendarEvents, reminders, workingHours] = await Promise.all([
    db.taskDependency.findMany({
      where: { userId, taskId: { in: taskIds } },
      select: { taskId: true, dependsOnId: true },
    }),
    db.calendarEvent.findMany({
      where: {
        userId,
        deletedAt: null,
        startAt: { lt: range.end },
        endAt: { gt: range.start },
        status: { not: 'CANCELLED' },
      },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        isAllDay: true,
        status: true,
        title: true,
      },
    }),
    db.reminder.findMany({
      where: { userId, remindAt: { gte: range.start, lt: range.end }, status: 'PENDING' },
      select: { id: true, remindAt: true, status: true, title: true },
    }),
    db.workingHoursBlock.findMany({
      where: { userId },
      select: { weekday: true, startMinute: true, endMinute: true },
    }),
  ]);

  const input = {
    userId,
    date,
    timeZone,
    planningPreferences: {
      defaultTaskDurationMinutes: minutes(
        planningPreferences?.defaultTaskDurationMinutes ?? 30,
      ) as DurationMinutes,
      preferredPlanningMinute: planningPreferences?.preferredPlanningMinute ?? null,
      schedulingStrategy: planningPreferences?.schedulingStrategy ?? 'BALANCED',
      autonomyLevel: planningPreferences?.autonomyLevel ?? 'ASK_BEFORE_CHANGING',
      maxDailyFocusMinutes: minutes(
        planningPreferences?.maxDailyFocusMinutes ?? 360,
      ) as DurationMinutes,
      minBreakMinutes: minutes(planningPreferences?.minBreakMinutes ?? 10) as DurationMinutes,
      bufferMinutes: minutes(planningPreferences?.bufferMinutes ?? 5) as DurationMinutes,
      allowWeekendScheduling: planningPreferences?.allowWeekendScheduling ?? false,
    } satisfies PlanningInput['planningPreferences'],
    workingHours: workingHours.map((hours) => ({
      weekday: hours.weekday,
      startMinute: hours.startMinute,
      endMinute: hours.endMinute,
    })),
    tasks: uniqueTasks.map((task) => ({
      id: task.id,
      title: task.title,
      priority: task.priority,
      status: task.status,
      estimatedMinutes: minutes(task.estimatedMinutes),
      dueAt: task.dueAt,
      scheduledStart: task.scheduledStart,
      scheduledEnd: task.scheduledEnd,
      goalId: task.goalId,
    })),
    calendarEvents: calendarEvents.map((event): PlanningCalendarEvent => ({
      id: event.id,
      startAt: event.startAt,
      endAt: event.endAt,
      isAllDay: event.isAllDay,
      status: event.status,
      title: event.title,
    })),
    reminders: reminders.map((reminder): PlanningReminder => ({
      id: reminder.id,
      remindAt: reminder.remindAt,
      status: reminder.status,
      title: reminder.title,
    })),
    dependencies,
    existingItems: existingItems.map((item) => ({
      id: item.id,
      kind: item.kind,
      position: item.position,
      scheduledStart: item.scheduledStart,
      scheduledEnd: item.scheduledEnd,
      taskId: item.taskId,
      reminderId: item.reminderId,
      calendarEventId: item.calendarEventId,
    })),
    space,
  } satisfies PlanningInput;

  logger.debug(
    { tasks: taskIds.length, events: calendarEvents.length },
    'planning snapshot loaded',
  );

  return input;
};
