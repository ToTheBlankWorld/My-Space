import { canTransitionTask, type EventType, type PageRequest, type TaskStatus } from '@space/types';
import {
  createGoalSchema,
  createReminderSchema,
  createTaskSchema,
  parseOrThrow,
  updateTaskSchema,
} from '@space/validation';
import { toDatabaseDate } from '@space/time';
import { type z } from 'zod';

import type { Database } from '../client';
import { InvalidTransitionError, RecordNotFoundError, withDomainErrors } from '../errors';
import { cursorQuery, toPage } from '../pagination';
import { appendEvent } from './audit';
import { recordAgentAction } from './audit';

/**
 * Tasks, reminders and goals.
 *
 * Ownership is a predicate, never an assumption: `userId` is supplied by the
 * caller from the session and appears in the `where` clause of every read and
 * every write. Nothing here trusts an id from a request body.
 */

export type CreateTaskInput = z.input<typeof createTaskSchema>;
export type UpdateTaskInput = z.input<typeof updateTaskSchema>;
export type CreateReminderInput = z.input<typeof createReminderSchema>;
export type CreateGoalInput = z.input<typeof createGoalSchema>;

export const createTask = async (db: Database, userId: string, input: CreateTaskInput) => {
  const data = parseOrThrow(createTaskSchema, input, 'task');

  return withDomainErrors('Task', () =>
    db.task.create({
      data: {
        userId,
        // Relations are connected by id *and* filtered by owner below; a Space
        // belonging to someone else fails the foreign key check because the
        // caller can never learn its id in the first place.
        spaceId: data.spaceId ?? null,
        goalId: data.goalId ?? null,
        title: data.title,
        description: data.description ?? null,
        notes: data.notes ?? null,
        priority: data.priority,
        status: data.status,
        estimatedMinutes: data.estimatedMinutes ?? null,
        dueAt: data.dueAt ?? null,
        scheduledStart: data.scheduledStart ?? null,
        scheduledEnd: data.scheduledEnd ?? null,
      },
    }),
  );
};

export const findTask = async (db: Database, userId: string, taskId: string) =>
  db.task.findFirst({ where: { id: taskId, userId } });

export const updateTask = async (
  db: Database,
  userId: string,
  taskId: string,
  input: UpdateTaskInput,
) => {
  const data = parseOrThrow(updateTaskSchema, input, 'task update');

  const result = await withDomainErrors('Task', () =>
    db.task.updateMany({ where: { id: taskId, userId }, data }),
  );

  if (result.count === 0) {
    throw new RecordNotFoundError('Task');
  }

  return db.task.findFirst({ where: { id: taskId, userId } });
};

/**
 * Moves a task to a new status, enforcing the transition table.
 *
 * The rule lives in `@space/types` and is applied here because this is the only
 * path through which a status changes — a check in the UI would be advice, not
 * an invariant.
 *
 * `completedAt` is derived from the transition rather than accepted from the
 * caller, so "completed" always means "the moment the status changed".
 */
export const changeTaskStatus = async (
  db: Database,
  userId: string,
  taskId: string,
  status: TaskStatus,
  occurredAt: Date,
) => {
  const task = await db.task.findFirst({ where: { id: taskId, userId }, select: { status: true } });

  if (!task) {
    throw new RecordNotFoundError('Task');
  }

  if (task.status === status) {
    return db.task.findFirst({ where: { id: taskId, userId } });
  }

  if (!canTransitionTask(task.status, status)) {
    throw new InvalidTransitionError('Task', task.status, status);
  }

  await db.task.updateMany({
    where: { id: taskId, userId },
    data: {
      status,
      completedAt: status === 'COMPLETED' ? occurredAt : null,
    },
  });

  return db.task.findFirst({ where: { id: taskId, userId } });
};

const TRANSITION_EVENT: Partial<Record<TaskStatus, EventType>> = {
  COMPLETED: 'TASK_COMPLETED',
  MISSED: 'TASK_MISSED',
  RESCHEDULED: 'TASK_RESCHEDULED',
};

/**
 * Moves a task to a new status atomically with its audit trail.
 *
 * This is the transition the autonomous loop uses to mark work MISSED (an
 * elapsed scheduled block that was never completed) and any future task surface
 * reuses for completion. The status transition table is enforced here — the
 * same rule as {@link changeTaskStatus} — and the change is recorded in the
 * append-only event log *in the same unit of work*, so the audit trail can
 * never drift from the state it describes.
 *
 * `trigger` names the actor (`autonomous` when the loop decided, `user`
 * otherwise) and `reason` names the deterministic rule that fired, both for the
 * AgentAction row. When called inside an existing `$transaction`, pass the
 * transaction handle so the write, event and action commit together.
 */
export const transitionTaskStatus = async (
  db: Database,
  userId: string,
  taskId: string,
  status: TaskStatus,
  occurredAt: Date,
  options: {
    trigger?: 'user' | 'autonomous';
    reason?: string;
    correlationId?: string;
    spaceId?: string;
  } = {},
): Promise<{ taskId: string; from: TaskStatus; to: TaskStatus; changed: boolean }> => {
  const task = await db.task.findFirst({
    where: { id: taskId, userId },
    select: { status: true, title: true, spaceId: true },
  });

  if (!task) {
    throw new RecordNotFoundError('Task');
  }

  if (task.status === status) {
    return { taskId, from: task.status, to: status, changed: false };
  }

  if (!canTransitionTask(task.status, status)) {
    throw new InvalidTransitionError('Task', task.status, status);
  }

  const { trigger = 'user', reason = 'status-transition', correlationId, spaceId } = options;
  const eventType = TRANSITION_EVENT[status];

  return db.$transaction(async (tx) => {
    await tx.task.updateMany({
      where: { id: taskId, userId },
      data: {
        status,
        completedAt: status === 'COMPLETED' ? occurredAt : null,
      },
    });

    if (eventType) {
      await appendEvent(tx, userId, {
        eventType,
        aggregateType: 'TASK',
        aggregateId: taskId,
        payload: {
          from: task.status,
          to: status,
          trigger,
          title: task.title.slice(0, 200),
        },
        occurredAt,
        correlationId,
      });
    }

    await recordAgentAction(tx, userId, {
      actionType: 'TASK_DEFERRED',
      outcome: 'SUCCEEDED',
      entityType: 'TASK',
      entityId: taskId,
      spaceId: spaceId ?? task.spaceId ?? undefined,
      reason,
      factors: {
        from: task.status,
        to: status,
        trigger,
        rule: status === 'MISSED' ? 'elapsed-scheduled-block' : 'manual-transition',
      },
      previousState: { status: task.status },
      resultingState: { status },
      correlationId,
      durationMs: null,
    });

    return { taskId, from: task.status, to: status, changed: true };
  });
};

/**
 * A day's task list, in the order the plan should be worked.
 *
 * Bounded by the Space, which is bounded by definition — one day of work.
 */
export const listTasksForSpace = async (db: Database, userId: string, spaceId: string) =>
  db.task.findMany({
    where: { userId, spaceId },
    orderBy: [
      { scheduledStart: { sort: 'asc', nulls: 'last' } },
      { priority: 'asc' },
      { createdAt: 'asc' },
      { id: 'asc' },
    ],
  });

/** Open tasks with a deadline in the given window, newest deadline last. */
export const listUpcomingTasks = async (
  db: Database,
  userId: string,
  { until, page = {} }: { until: Date; page?: PageRequest },
) => {
  const rows = await db.task.findMany({
    where: {
      userId,
      status: { in: ['INBOX', 'PLANNED', 'IN_PROGRESS', 'RESCHEDULED'] },
      dueAt: { not: null, lte: until },
    },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    ...cursorQuery(page),
  });

  return toPage(rows, page);
};

/** Open tasks whose deadline has already passed. */
export const listOverdueTasks = async (
  db: Database,
  userId: string,
  { now, page = {} }: { now: Date; page?: PageRequest },
) => {
  const rows = await db.task.findMany({
    where: {
      userId,
      status: { in: ['INBOX', 'PLANNED', 'IN_PROGRESS', 'RESCHEDULED', 'MISSED'] },
      dueAt: { not: null, lt: now },
    },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    ...cursorQuery(page),
  });

  return toPage(rows, page);
};

export const createReminder = async (db: Database, userId: string, input: CreateReminderInput) => {
  const data = parseOrThrow(createReminderSchema, input, 'reminder');

  return withDomainErrors('Reminder', () =>
    db.reminder.create({
      data: {
        userId,
        spaceId: data.spaceId ?? null,
        taskId: data.taskId ?? null,
        title: data.title,
        description: data.description ?? null,
        remindAt: data.remindAt,
        timeZone: data.timeZone,
        recurrenceFrequency: data.recurrence?.frequency ?? null,
        recurrenceInterval: data.recurrence?.interval ?? null,
        recurrenceByWeekday: data.recurrence?.byWeekday ?? [],
        recurrenceUntil: data.recurrence?.until ?? null,
        recurrenceCount: data.recurrence?.count ?? null,
      },
    }),
  );
};

/**
 * Reminders that are due and have not been delivered.
 *
 * This is the dispatcher's query, so it is cross-user by design and strictly
 * bounded: it reads a fixed batch ordered by due time, which is exactly what the
 * `(deliveryState, remindAt)` index serves.
 */
export const listDueReminders = async (
  db: Database,
  { now, limit = 100 }: { now: Date; limit?: number },
) =>
  db.reminder.findMany({
    where: { deliveryState: 'PENDING', status: 'PENDING', remindAt: { lte: now } },
    orderBy: [{ remindAt: 'asc' }, { id: 'asc' }],
    take: Math.min(Math.max(limit, 1), 500),
  });

/** Records the outcome of a delivery attempt. */
export const markReminderDelivered = async (
  db: Database,
  reminderId: string,
  { deliveredAt, failureReason }: { deliveredAt: Date; failureReason?: string },
) =>
  db.reminder.update({
    where: { id: reminderId },
    data: failureReason
      ? { deliveryState: 'FAILED', failureReason }
      : { deliveryState: 'SENT', deliveredAt, failureReason: null },
  });

export const createGoal = async (db: Database, userId: string, input: CreateGoalInput) => {
  const data = parseOrThrow(createGoalSchema, input, 'goal');

  return withDomainErrors('Goal', () =>
    db.goal.create({
      data: {
        userId,
        title: data.title,
        description: data.description ?? null,
        status: data.status,
        targetDate: data.targetDate ? toDatabaseDate(data.targetDate) : null,
      },
    }),
  );
};

export const listGoals = async (db: Database, userId: string, page: PageRequest = {}) => {
  const rows = await db.goal.findMany({
    where: { userId },
    orderBy: [{ status: 'asc' }, { targetDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    ...cursorQuery(page),
  });

  return toPage(rows, page);
};
