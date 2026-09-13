import {
  AGENT_ACTION_OUTCOMES,
  AGENT_ACTION_TYPES,
  AGGREGATE_TYPES,
  AUTONOMY_LEVELS,
  CALENDAR_EVENT_STATUSES,
  CALENDAR_PROVIDERS,
  CONNECTION_STATUSES,
  DELIVERY_STATES,
  EMAIL_STATUSES,
  EVENT_TYPES,
  GOAL_STATUSES,
  JOB_STATUSES,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_TYPES,
  RECURRENCE_FREQUENCIES,
  REMINDER_STATUSES,
  SCHEDULING_STRATEGIES,
  SPACE_ITEM_KINDS,
  SPACE_STATUSES,
  SYNC_STATES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  USER_STATUSES,
  WEEKDAYS,
} from '@space/types';
import { describe, expect, it } from 'vitest';

import * as prismaEnums from '../generated/prisma/enums';

/**
 * The database and the domain vocabulary must agree, exactly.
 *
 * `@space/types` is the source of truth; the Prisma schema mirrors it. Nothing
 * enforces that at compile time — the schema is not TypeScript — so it is
 * enforced here. A value added to one side and not the other fails CI instead of
 * failing at runtime with a constraint violation on a live database.
 *
 * Order matters too: the enum order is the sort order PostgreSQL uses, and
 * queries rely on it (task priority sorts CRITICAL first, notification priority
 * sorts CRITICAL first).
 */

const cases: [string, readonly string[], Record<string, string>][] = [
  ['UserStatus', USER_STATUSES, prismaEnums.UserStatus],
  ['AutonomyLevel', AUTONOMY_LEVELS, prismaEnums.AutonomyLevel],
  ['SchedulingStrategy', SCHEDULING_STRATEGIES, prismaEnums.SchedulingStrategy],
  ['Weekday', WEEKDAYS, prismaEnums.Weekday],
  ['SpaceStatus', SPACE_STATUSES, prismaEnums.SpaceStatus],
  ['SpaceItemKind', SPACE_ITEM_KINDS, prismaEnums.SpaceItemKind],
  ['TaskPriority', TASK_PRIORITIES, prismaEnums.TaskPriority],
  ['TaskStatus', TASK_STATUSES, prismaEnums.TaskStatus],
  ['ReminderStatus', REMINDER_STATUSES, prismaEnums.ReminderStatus],
  ['DeliveryState', DELIVERY_STATES, prismaEnums.DeliveryState],
  ['RecurrenceFrequency', RECURRENCE_FREQUENCIES, prismaEnums.RecurrenceFrequency],
  ['GoalStatus', GOAL_STATUSES, prismaEnums.GoalStatus],
  ['CalendarProvider', CALENDAR_PROVIDERS, prismaEnums.CalendarProvider],
  ['ConnectionStatus', CONNECTION_STATUSES, prismaEnums.ConnectionStatus],
  ['CalendarEventStatus', CALENDAR_EVENT_STATUSES, prismaEnums.CalendarEventStatus],
  ['SyncState', SYNC_STATES, prismaEnums.SyncState],
  ['NotificationType', NOTIFICATION_TYPES, prismaEnums.NotificationType],
  ['NotificationPriority', NOTIFICATION_PRIORITIES, prismaEnums.NotificationPriority],
  ['EmailStatus', EMAIL_STATUSES, prismaEnums.EmailStatus],
  ['JobStatus', JOB_STATUSES, prismaEnums.JobStatus],
  ['AgentActionType', AGENT_ACTION_TYPES, prismaEnums.AgentActionType],
  ['AgentActionOutcome', AGENT_ACTION_OUTCOMES, prismaEnums.AgentActionOutcome],
  ['EventType', EVENT_TYPES, prismaEnums.EventType],
  ['AggregateType', AGGREGATE_TYPES, prismaEnums.AggregateType],
];

describe('domain enums match the database schema', () => {
  it.each(cases)('%s has identical values in the same order', (_name, domain, prisma) => {
    expect(Object.values(prisma)).toEqual([...domain]);
  });

  it('covers every enum the schema defines', () => {
    // A new Prisma enum with no domain counterpart means validation cannot
    // produce the values the database accepts.
    const generated = Object.keys(prismaEnums).sort();
    const checked = cases.map(([name]) => name).sort();

    expect(generated).toEqual(checked);
  });

  it('sorts task priority from most to least urgent', () => {
    // Queries order by this enum directly, so the declaration order is load bearing.
    expect(Object.values(prismaEnums.TaskPriority)[0]).toBe('CRITICAL');
  });

  it('sorts notification priority from loudest to quietest', () => {
    expect(Object.values(prismaEnums.NotificationPriority)).toEqual([
      'CRITICAL',
      'IMPORTANT',
      'NORMAL',
      'SILENT',
    ]);
  });
});
