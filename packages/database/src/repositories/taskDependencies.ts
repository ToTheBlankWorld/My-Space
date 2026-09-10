import { createDependencySchema, parseOrThrow } from '@space/validation';
import { type z } from 'zod';

import type { Database } from '../client';
import { withDomainErrors } from '../errors';

/**
 * Task dependencies: prerequisite edges between a user's tasks.
 *
 * Ownership is a predicate, never an assumption: `userId` is supplied by the
 * caller from the session and appears in the `where` clause of every read and
 * every write.
 *
 * A dependency edge is idempotent — the composite unique key
 * `(taskId, dependsOnId)` means re-adding it is a no-op — and a task can never
 * depend on itself, enforced by the validation schema and a database CHECK
 * constraint.
 */

export type CreateDependencyInput = z.input<typeof createDependencySchema>;

/**
 * Adds a dependency edge.
 *
 * The unique key makes this a natural `upsert`: two planner passes racing to
 * persist the same edge cannot both insert.
 */
export const createDependency = async (
  db: Database,
  userId: string,
  input: CreateDependencyInput,
) => {
  const data = parseOrThrow(createDependencySchema, input, 'task dependency');

  return withDomainErrors('TaskDependency', () =>
    db.taskDependency.create({
      data: {
        userId,
        taskId: data.taskId,
        dependsOnId: data.dependsOnId,
      },
    }),
  );
};

/**
 * Removes a dependency edge. `updateMany`-style predicate keeps the owner in
 * the WHERE clause; `deleteMany` returns a count so a miss is observable.
 */
export const deleteDependency = async (
  db: Database,
  userId: string,
  taskId: string,
  dependsOnId: string,
) => {
  const { count } = await db.taskDependency.deleteMany({
    where: { userId, taskId, dependsOnId },
  });

  return count === 1;
};

/** Every edge for one task, both inbound (its prerequisites) and outbound. */
export const listDependenciesForTask = async (db: Database, userId: string, taskId: string) =>
  db.taskDependency.findMany({
    where: { userId, taskId },
    orderBy: [{ dependsOnId: 'asc' }, { id: 'asc' }],
  });

/**
 * Every edge involving any of the given tasks.
 *
 * This is the Space Engine's loading query: given the tasks of a day, it
 * returns the dependency subgraph the Dependencies component needs, in a total
 * order so two runs against unchanged data produce the same sequence.
 */
export const listDependenciesForTasks = async (db: Database, userId: string, taskIds: string[]) => {
  if (taskIds.length === 0) {
    return [];
  }

  return db.taskDependency.findMany({
    where: { userId, taskId: { in: taskIds } },
    orderBy: [{ taskId: 'asc' }, { dependsOnId: 'asc' }, { id: 'asc' }],
  });
};

/** Every dependency a user has recorded, bounded for housekeeping/export. */
export const listAllDependencies = async (db: Database, userId: string) =>
  db.taskDependency.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 10_000,
  });
