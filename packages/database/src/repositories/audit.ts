import { toDatabaseDate } from '@space/time';
import type { CalendarDate, PageRequest } from '@space/types';
import { appendEventSchema, parseOrThrow, recordAgentActionSchema } from '@space/validation';
import { type z } from 'zod';

import type { Database } from '../client';
import { type Prisma } from '../generated/prisma/client';
import { withDomainErrors } from '../errors';
import { cursorQuery, resolveLimit, toPage } from '../pagination';

/**
 * The event log, the engine's audit trail, and daily roll-ups.
 *
 * The event log is append-only. Nothing in this module updates or deletes a row:
 * an event that turned out to be wrong is corrected by a later, compensating
 * event, which is what makes the log replayable.
 */

export type AppendEventInput = z.input<typeof appendEventSchema>;
export type RecordAgentActionInput = z.input<typeof recordAgentActionSchema>;

/**
 * Appends a domain event.
 *
 * `occurredAt` is supplied by the caller from an injected clock rather than
 * defaulted in the database, so a replay produces identical timestamps.
 */
export const appendEvent = async (db: Database, userId: string, input: AppendEventInput) => {
  const data = parseOrThrow(appendEventSchema, input, 'event');

  return withDomainErrors('EventLog', () =>
    db.eventLog.create({
      data: {
        userId,
        eventType: data.eventType,
        aggregateType: data.aggregateType,
        aggregateId: data.aggregateId,
        payload: data.payload as Prisma.InputJsonObject,
        ...(data.occurredAt ? { occurredAt: data.occurredAt } : {}),
        correlationId: data.correlationId ?? null,
        causationId: data.causationId ?? null,
      },
    }),
  );
};

/** Appends several events in one statement, for a single unit of work. */
export const appendEvents = async (
  db: Database,
  userId: string,
  inputs: readonly AppendEventInput[],
) => {
  const rows = inputs.map((input) => {
    const data = parseOrThrow(appendEventSchema, input, 'event');
    return {
      userId,
      eventType: data.eventType,
      aggregateType: data.aggregateType,
      aggregateId: data.aggregateId,
      payload: data.payload as Prisma.InputJsonObject,
      ...(data.occurredAt ? { occurredAt: data.occurredAt } : {}),
      correlationId: data.correlationId ?? null,
      causationId: data.causationId ?? null,
    };
  });

  return withDomainErrors('EventLog', () => db.eventLog.createMany({ data: rows }));
};

/** A user's activity feed, newest first. */
export const listUserEvents = async (db: Database, userId: string, page: PageRequest = {}) => {
  const rows = await db.eventLog.findMany({
    where: { userId },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    ...cursorQuery(page),
  });

  return toPage(rows, page);
};

/** The history of one entity, oldest first — the order a replay needs. */
export const listAggregateEvents = async (
  db: Database,
  userId: string,
  { aggregateId, limit = 100 }: { aggregateId: string; limit?: number },
) =>
  db.eventLog.findMany({
    where: { userId, aggregateId },
    orderBy: [{ occurredAt: 'asc' }, { sequence: 'asc' }],
    take: resolveLimit(limit),
  });

export interface OutboxBatch {
  events: {
    id: string;
    sequence: string;
    eventType: string;
    userId: string;
    aggregateType: string;
    aggregateId: string;
    payload: unknown;
    occurredAt: Date;
    correlationId: string | null;
    causationId: string | null;
  }[];
  /** Pass back as `afterSequence` to continue. `null` when the log is drained. */
  nextCursor: string | null;
}

/**
 * Reads the log in strict global order, for the queue consumer Stage 7 will add.
 *
 * The cursor is `sequence`, a monotonic bigint, because cuid identifiers are not
 * totally ordered and `occurredAt` can tie. `sequence` is returned as a string:
 * a `bigint` does not survive JSON, and every consumer of this batch will
 * eventually serialise it.
 */
export const readEventOutbox = async (
  db: Database,
  {
    afterSequence,
    eventType,
    limit = 100,
  }: { afterSequence?: string | bigint | null; eventType?: string; limit?: number } = {},
): Promise<OutboxBatch> => {
  const take = resolveLimit(limit);
  const cursor =
    afterSequence === null || afterSequence === undefined ? null : BigInt(afterSequence);

  const rows = await db.eventLog.findMany({
    where: {
      ...(cursor === null ? {} : { sequence: { gt: cursor } }),
      // Callers filter to the event types they act on (eg. PLANNING_COMPLETED);
      // `as never` bridges the generated enum for dynamic values.
      ...(eventType === undefined ? {} : { eventType: eventType as never }),
    },
    orderBy: { sequence: 'asc' },
    take,
  });

  const events = rows.map((row) => ({
    ...row,
    sequence: row.sequence.toString(),
  }));

  return {
    events,
    nextCursor: events.length === take ? (events[events.length - 1]?.sequence ?? null) : null,
  };
};

/**
 * The last EventLog `sequence` a consumer committed, or null when it has never
 * run. The cursor is owned by one consumer (`processorName`); two consumers
 * never share a row.
 */
export const getOutboxCursor = async (db: Database, processorName: string) => {
  const row = await db.outboxCursor.findUnique({ where: { processorName } });
  return row
    ? { processorName: row.processorName, lastSequence: row.lastSequence.toString() }
    : null;
};

/**
 * Advances (or seeds) a consumer's cursor to `lastSequence`.
 *
 * Call only after the effects for that batch have been committed in the same
 * unit of work: the cursor is the contract "everything up to and including this
 * sequence has been applied". Replaying from it must be safe, which is why the
 * notification pipeline keys its effects with idempotency keys.
 */
export const advanceOutboxCursor = async (
  db: Database,
  processorName: string,
  lastSequence: string | bigint,
) => {
  await db.outboxCursor.upsert({
    where: { processorName },
    create: { processorName, lastSequence: BigInt(lastSequence) },
    update: { lastSequence: BigInt(lastSequence) },
  });
};

/**
 * Records a decision made by the deterministic Space Engine.
 *
 * Every row names the rule that fired (`reason`) and the inputs it read
 * (`factors`). This is an audit trail of rule execution — there is no model and
 * no inference anywhere in the system — and it is what lets the product tell a
 * user exactly why their day changed.
 */
export const recordAgentAction = async (
  db: Database,
  userId: string,
  input: RecordAgentActionInput,
) => {
  const data = parseOrThrow(recordAgentActionSchema, input, 'agent action');

  return withDomainErrors('AgentAction', () =>
    db.agentAction.create({
      data: {
        userId,
        spaceId: data.spaceId ?? null,
        actionType: data.actionType,
        outcome: data.outcome,
        entityType: data.entityType ?? null,
        entityId: data.entityId ?? null,
        reason: data.reason,
        factors: data.factors as Prisma.InputJsonObject,
        previousState: (data.previousState ?? undefined) as Prisma.InputJsonObject | undefined,
        resultingState: (data.resultingState ?? undefined) as Prisma.InputJsonObject | undefined,
        correlationId: data.correlationId ?? null,
        durationMs: data.durationMs ?? null,
      },
    }),
  );
};

/** Why a given day looks the way it does, newest decision first. */
export const listAgentActionsForSpace = async (
  db: Database,
  userId: string,
  spaceId: string,
  page: PageRequest = {},
) => {
  const rows = await db.agentAction.findMany({
    where: { userId, spaceId },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    ...cursorQuery(page),
  });

  return toPage(rows, page);
};

export interface ProductivitySnapshotInput {
  date: CalendarDate | string;
  timeZone: string;
  tasksPlanned: number;
  tasksCompleted: number;
  tasksMissed: number;
  plannedMinutes: number;
  completedMinutes: number;
}

/**
 * Writes one day's roll-up.
 *
 * Idempotent on `(userId, date)`: recomputing a day overwrites its snapshot,
 * which is what makes a backfill safe to re-run.
 */
export const upsertProductivitySnapshot = async (
  db: Database,
  userId: string,
  input: ProductivitySnapshotInput,
  { computedAt }: { computedAt: Date },
) => {
  const date = toDatabaseDate(input.date);
  const metrics = {
    timeZone: input.timeZone,
    tasksPlanned: input.tasksPlanned,
    tasksCompleted: input.tasksCompleted,
    tasksMissed: input.tasksMissed,
    plannedMinutes: input.plannedMinutes,
    completedMinutes: input.completedMinutes,
    computedAt,
  };

  return withDomainErrors('ProductivitySnapshot', () =>
    db.productivitySnapshot.upsert({
      where: { userId_date: { userId, date } },
      create: { userId, date, ...metrics },
      update: metrics,
    }),
  );
};
