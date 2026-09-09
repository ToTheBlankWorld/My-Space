import { parseOrThrow } from '@space/validation';
import {
  createUserSchema,
  planningPreferencesSchema,
  userPreferencesSchema,
  workingHoursBlockSchema,
} from '@space/validation';
import { type z } from 'zod';

import type { Database } from '../client';
import { withDomainErrors } from '../errors';

/**
 * Accounts and the preferences the planning engines read.
 *
 * Every function takes the database handle first, so the same code runs inside
 * or outside a transaction.
 */

export type CreateUserInput = z.input<typeof createUserSchema>;
export type UserPreferencesInput = z.input<typeof userPreferencesSchema>;
export type PlanningPreferencesInput = z.input<typeof planningPreferencesSchema>;
export type WorkingHoursInput = z.input<typeof workingHoursBlockSchema>;

/**
 * Columns safe to return from a generic read.
 *
 * Selected explicitly rather than returning the whole row: `select` is the only
 * thing that stops a column added in a later migration — a token, a hash — from
 * silently appearing in an API response.
 */
export const userPublicFields = {
  id: true,
  email: true,
  name: true,
  imageUrl: true,
  status: true,
  createdAt: true,
} as const;

export const createUser = async (db: Database, input: CreateUserInput) => {
  const data = parseOrThrow(createUserSchema, input, 'user');

  return withDomainErrors('User', () => db.user.create({ data, select: userPublicFields }));
};

export const findUserById = async (db: Database, userId: string) =>
  db.user.findFirst({
    // A soft-deleted account must not resolve: it is gone as far as the product
    // is concerned, even while its rows await purging.
    where: { id: userId, deletedAt: null },
    select: userPublicFields,
  });

export const findUserByEmail = async (db: Database, email: string) =>
  db.user.findFirst({
    where: { email: email.trim().toLowerCase(), deletedAt: null },
    select: userPublicFields,
  });

/** Creates or replaces the user's presentation preferences. */
export const upsertUserPreferences = async (
  db: Database,
  userId: string,
  input: UserPreferencesInput,
) => {
  const data = parseOrThrow(userPreferencesSchema, input, 'user preferences');

  return withDomainErrors('UserPreferences', () =>
    db.userPreferences.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    }),
  );
};

/** Creates or replaces the inputs the Space Engine reads when planning. */
export const upsertPlanningPreferences = async (
  db: Database,
  userId: string,
  input: PlanningPreferencesInput,
) => {
  const data = parseOrThrow(planningPreferencesSchema, input, 'planning preferences');

  return withDomainErrors('PlanningPreferences', () =>
    db.planningPreferences.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    }),
  );
};

/**
 * Replaces the whole availability grid in one transaction.
 *
 * Availability is edited as a set, not row by row: a partial update would leave
 * the scheduler reading a half-applied week.
 */
export const replaceWorkingHours = async (
  db: Database,
  userId: string,
  blocks: readonly WorkingHoursInput[],
) => {
  const parsed = blocks.map((block) =>
    parseOrThrow(workingHoursBlockSchema, block, 'working hours'),
  );

  return withDomainErrors('WorkingHoursBlock', async () => {
    await db.workingHoursBlock.deleteMany({ where: { userId } });
    await db.workingHoursBlock.createMany({
      data: parsed.map((block) => ({ userId, ...block })),
    });

    return db.workingHoursBlock.findMany({
      where: { userId },
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
    });
  });
};

/** The full profile the planning engines need, in one round trip. */
export const findPlanningProfile = async (db: Database, userId: string) =>
  db.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      ...userPublicFields,
      preferences: true,
      planningPreferences: true,
      workingHours: { orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] },
    },
  });
