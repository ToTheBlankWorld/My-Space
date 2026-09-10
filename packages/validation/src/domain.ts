import {
  AGENT_ACTION_OUTCOMES,
  AGENT_ACTION_TYPES,
  AGGREGATE_TYPES,
  AUTONOMY_LEVELS,
  CALENDAR_EVENT_STATUSES,
  CALENDAR_PROVIDERS,
  DEFAULT_PAGE_SIZE,
  DELIVERY_STATES,
  EVENT_TYPES,
  GOAL_STATUSES,
  MAX_PAGE_SIZE,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_TYPES,
  RECURRENCE_FREQUENCIES,
  REMINDER_STATUSES,
  SCHEDULING_STRATEGIES,
  SPACE_STATUSES,
  SYNC_STATES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  WEEKDAYS,
} from '@space/types';
import type { DurationMinutes } from '@space/types';
import { z } from 'zod';

import { emailSchema, entityIdSchema, externalIdSchema } from './identifiers';
import { nonEmptyStringSchema } from './primitives';
import {
  calendarDateSchema,
  durationMinutesSchema,
  instantSchema,
  minuteOfDaySchema,
  timeZoneSchema,
} from './temporal';

/**
 * Input schemas for the persistence layer.
 *
 * Every enum here is derived from the `@space/types` vocabulary, so validation
 * and the database can never disagree about which values exist.
 *
 * These schemas describe *what a caller may send*. They deliberately contain no
 * `userId`: ownership is supplied by the server from the authenticated session
 * and is never read from the request body.
 */

export const autonomyLevelSchema = z.enum(AUTONOMY_LEVELS);
export const schedulingStrategySchema = z.enum(SCHEDULING_STRATEGIES);
export const weekdaySchema = z.enum(WEEKDAYS);
export const spaceStatusSchema = z.enum(SPACE_STATUSES);
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);
export const taskStatusSchema = z.enum(TASK_STATUSES);
export const reminderStatusSchema = z.enum(REMINDER_STATUSES);
export const deliveryStateSchema = z.enum(DELIVERY_STATES);
export const recurrenceFrequencySchema = z.enum(RECURRENCE_FREQUENCIES);
export const goalStatusSchema = z.enum(GOAL_STATUSES);
export const calendarProviderSchema = z.enum(CALENDAR_PROVIDERS);
export const calendarEventStatusSchema = z.enum(CALENDAR_EVENT_STATUSES);
export const syncStateSchema = z.enum(SYNC_STATES);
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export const notificationPrioritySchema = z.enum(NOTIFICATION_PRIORITIES);
export const agentActionTypeSchema = z.enum(AGENT_ACTION_TYPES);
export const agentActionOutcomeSchema = z.enum(AGENT_ACTION_OUTCOMES);
export const eventTypeSchema = z.enum(EVENT_TYPES);
export const aggregateTypeSchema = z.enum(AGGREGATE_TYPES);

/**
 * Defaults for branded numeric columns.
 *
 * The brand is applied by the schemas themselves, so a literal default has to be
 * narrowed explicitly rather than silently accepted as a bare number.
 */
const minutes = (value: number): DurationMinutes => value as DurationMinutes;

/** Free text a user types. Bounded so a single row cannot hold a document. */
const titleSchema = nonEmptyStringSchema.max(200, { message: 'must be at most 200 characters' });
const bodySchema = z.string().trim().max(10_000, { message: 'must be at most 10000 characters' });

/** Cursor pagination input, capped so one request cannot read an entire history. */
export const pageRequestSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: entityIdSchema.nullish(),
});
export type PageRequestInput = z.output<typeof pageRequestSchema>;

/**
 * A half-open instant range `[start, end)`.
 *
 * Half-open ranges compose without double counting, which matters once the
 * Conflict Engine starts comparing blocks of time.
 */
export const instantRangeSchema = z
  .object({ start: instantSchema, end: instantSchema })
  .refine(({ start, end }) => start.getTime() < end.getTime(), {
    message: 'start must be strictly before end',
    path: ['end'],
  });

export const createUserSchema = z.object({
  email: emailSchema,
  name: nonEmptyStringSchema.max(120).optional(),
  imageUrl: z.url().max(2048).optional(),
});

export const userPreferencesSchema = z.object({
  timeZone: timeZoneSchema,
  locale: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(-[A-Za-z0-9]{2,8})*$/, { message: 'must be a BCP 47 language tag' })
    .default('en'),
  morningNotificationMinute: minuteOfDaySchema.nullish(),
  middayNotificationMinute: minuteOfDaySchema.nullish(),
  eveningNotificationMinute: minuteOfDaySchema.nullish(),
  notificationsEnabled: z.boolean().default(true),
  emailNotificationsEnabled: z.boolean().default(true),
});

export const planningPreferencesSchema = z.object({
  defaultTaskDurationMinutes: durationMinutesSchema.default(minutes(30)),
  preferredPlanningMinute: minuteOfDaySchema.nullish(),
  schedulingStrategy: schedulingStrategySchema.default('BALANCED'),
  autonomyLevel: autonomyLevelSchema.default('ASK_BEFORE_CHANGING'),
  maxDailyFocusMinutes: durationMinutesSchema.default(minutes(360)),
  minBreakMinutes: durationMinutesSchema.default(minutes(10)),
  bufferMinutes: durationMinutesSchema.default(minutes(5)),
  allowWeekendScheduling: z.boolean().default(false),
});

/** One block of availability on one weekday, in the user's local wall clock. */
export const workingHoursBlockSchema = z
  .object({
    weekday: weekdaySchema,
    startMinute: minuteOfDaySchema,
    endMinute: minuteOfDaySchema,
  })
  .refine(({ startMinute, endMinute }) => startMinute < endMinute, {
    message: 'startMinute must be before endMinute',
    path: ['endMinute'],
  });

export const createSpaceSchema = z.object({
  date: calendarDateSchema,
  /**
   * The zone the date is anchored in. Captured per Space so a later change to
   * the user's timezone cannot silently re-interpret past days.
   */
  timeZone: timeZoneSchema,
  status: spaceStatusSchema.default('DRAFT'),
  summary: bodySchema.optional(),
});

export const createTaskSchema = z.object({
  spaceId: entityIdSchema.nullish(),
  goalId: entityIdSchema.nullish(),
  title: titleSchema,
  description: bodySchema.optional(),
  priority: taskPrioritySchema.default('NORMAL'),
  status: taskStatusSchema.default('INBOX'),
  estimatedMinutes: durationMinutesSchema.nullish(),
  dueAt: instantSchema.nullish(),
  scheduledStart: instantSchema.nullish(),
  scheduledEnd: instantSchema.nullish(),
  notes: bodySchema.optional(),
});

export const updateTaskSchema = createTaskSchema
  .partial()
  .extend({ actualMinutes: durationMinutesSchema.nullish() });

/** A status change, kept separate so the transition rules apply in one place. */
export const changeTaskStatusSchema = z.object({
  status: taskStatusSchema,
  occurredAt: instantSchema.optional(),
});

/**
 * A dependency edge between two tasks: `taskId` cannot start before
 * `dependsOnId` finishes.
 *
 * `taskId !== dependsOnId` is enforced here and again by a database CHECK
 * constraint, so a self-edge cannot slip in through any path.
 */
export const createDependencySchema = z
  .object({
    taskId: entityIdSchema,
    dependsOnId: entityIdSchema,
  })
  .refine(({ taskId, dependsOnId }) => taskId !== dependsOnId, {
    message: 'a task cannot depend on itself',
    path: ['dependsOnId'],
  });

export type CreateDependencyInput = z.input<typeof createDependencySchema>;

/**
 * Recurrence, stored as structured columns rather than an opaque RRULE string.
 *
 * Structured fields can be queried (`WHERE frequency = 'WEEKLY'`) and validated;
 * a serialised rule can only be parsed in application code. `byWeekday` is the
 * one genuinely variable-length part, and it is a small integer array.
 */
export const recurrenceSchema = z
  .object({
    frequency: recurrenceFrequencySchema,
    interval: z.number().int().min(1).max(365).default(1),
    byWeekday: z.array(weekdaySchema).max(7).default([]),
    until: instantSchema.nullish(),
    count: z.number().int().min(1).max(1000).nullish(),
  })
  .refine(({ until, count }) => !(until && count), {
    message: 'a recurrence ends either at a date or after a count, not both',
    path: ['count'],
  });

export const createReminderSchema = z.object({
  spaceId: entityIdSchema.nullish(),
  taskId: entityIdSchema.nullish(),
  title: titleSchema,
  description: bodySchema.optional(),
  remindAt: instantSchema,
  timeZone: timeZoneSchema,
  recurrence: recurrenceSchema.nullish(),
});

export const createGoalSchema = z.object({
  title: titleSchema,
  description: bodySchema.optional(),
  status: goalStatusSchema.default('ACTIVE'),
  targetDate: calendarDateSchema.nullish(),
});

export const upsertCalendarEventSchema = z.object({
  calendarId: entityIdSchema,
  externalId: externalIdSchema,
  externalEtag: z.string().max(256).nullish(),
  title: titleSchema,
  description: bodySchema.optional(),
  location: z.string().trim().max(500).optional(),
  startAt: instantSchema,
  endAt: instantSchema,
  timeZone: timeZoneSchema,
  isAllDay: z.boolean().default(false),
  status: calendarEventStatusSchema.default('CONFIRMED'),
  syncState: syncStateSchema.default('SYNCED'),
  recurringEventId: externalIdSchema.nullish(),
  originalStartAt: instantSchema.nullish(),
});

export const createNotificationSchema = z.object({
  type: notificationTypeSchema,
  priority: notificationPrioritySchema.default('NORMAL'),
  title: titleSchema,
  body: bodySchema,
  scheduledAt: instantSchema.nullish(),
});

/**
 * A domain event.
 *
 * `payload` is genuinely schema-less: each event type carries its own shape and
 * the log must be able to store an event emitted by a newer deploy. It is
 * bounded in size by the repository, and never contains credentials.
 */
export const appendEventSchema = z.object({
  eventType: eventTypeSchema,
  aggregateType: aggregateTypeSchema,
  aggregateId: entityIdSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  occurredAt: instantSchema.optional(),
  correlationId: entityIdSchema.nullish(),
  causationId: entityIdSchema.nullish(),
});

/**
 * A decision made by the deterministic Space Engine.
 *
 * `factors` records the inputs a rule read and `reason` names the rule. This is
 * an audit trail of deterministic decisions, not a record of inference.
 */
export const recordAgentActionSchema = z.object({
  actionType: agentActionTypeSchema,
  outcome: agentActionOutcomeSchema.default('SUCCEEDED'),
  entityType: aggregateTypeSchema.nullish(),
  entityId: entityIdSchema.nullish(),
  spaceId: entityIdSchema.nullish(),
  reason: nonEmptyStringSchema.max(500),
  factors: z.record(z.string(), z.unknown()).default({}),
  previousState: z.record(z.string(), z.unknown()).nullish(),
  resultingState: z.record(z.string(), z.unknown()).nullish(),
  correlationId: entityIdSchema.nullish(),
  durationMs: z.number().int().min(0).max(3_600_000).nullish(),
});
