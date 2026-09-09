import type { DatabaseClient } from '@space/database';
import type { Clock } from '@space/time';
import { isValidTimeZone } from '@space/time';
import { MINUTES_PER_DAY } from '@space/types';
import {
  autonomyLevelSchema,
  durationMinutesSchema,
  minuteOfDaySchema,
  parseOrThrow,
  timeZoneSchema,
} from '@space/validation';
import { z } from 'zod';

/**
 * Onboarding: the first thing a new account does.
 *
 * Everything collected here already has a home in the Stage 2 schema —
 * `UserPreferences`, `PlanningPreferences` and `WorkingHoursBlock`. Nothing is
 * duplicated into an onboarding-specific table, so the planning engines read the
 * same rows the user filled in.
 */

/** The weekdays a working-hours answer is expanded across. */
const WORKING_WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] as const;

export const onboardingSchema = z
  .object({
    /**
     * An IANA identifier.
     *
     * The browser suggests one; the server validates it against the platform's
     * own timezone database and stores only what passes. A value the runtime
     * does not recognise is rejected, never stored "just in case".
     */
    timeZone: timeZoneSchema,
    locale: z
      .string()
      .trim()
      .regex(/^[a-z]{2}(-[A-Za-z0-9]{2,8})*$/, { message: 'must be a BCP 47 language tag' })
      .default('en'),

    /** Local wall-clock minutes; the working day the scheduler may use. */
    workingStartMinute: minuteOfDaySchema,
    workingEndMinute: minuteOfDaySchema,

    /** When the user wants the day planned. */
    preferredPlanningMinute: minuteOfDaySchema,

    morningNotificationMinute: minuteOfDaySchema.nullable().default(null),
    middayNotificationMinute: minuteOfDaySchema.nullable().default(null),
    eveningNotificationMinute: minuteOfDaySchema.nullable().default(null),

    defaultTaskDurationMinutes: durationMinutesSchema,
    autonomyLevel: autonomyLevelSchema,
  })
  .refine(({ workingStartMinute, workingEndMinute }) => workingStartMinute < workingEndMinute, {
    message: 'the working day must end after it starts',
    path: ['workingEndMinute'],
  })
  .refine(({ defaultTaskDurationMinutes }) => defaultTaskDurationMinutes <= MINUTES_PER_DAY, {
    message: 'a task cannot be longer than a day',
    path: ['defaultTaskDurationMinutes'],
  });

export type OnboardingInput = z.input<typeof onboardingSchema>;

export interface CompleteOnboardingOptions {
  database: DatabaseClient;
  clock: Clock;
  /** From the session. Never from the request body. */
  userId: string;
  input: unknown;
}

export interface OnboardingResult {
  readonly completedAt: Date;
  readonly timeZone: string;
}

/**
 * Records a user's answers and marks the account onboarded.
 *
 * One transaction: a half-applied onboarding would leave the scheduler with a
 * timezone but no working hours, which is worse than no answers at all.
 *
 * Idempotent — every write is an upsert or a full replacement — so a double
 * submit, or a user revisiting the form, updates rather than duplicates.
 */
export const completeOnboarding = async ({
  database,
  clock,
  userId,
  input,
}: CompleteOnboardingOptions): Promise<OnboardingResult> => {
  const answers = parseOrThrow(onboardingSchema, input, 'onboarding');

  // Belt and braces: the schema already refuses an unknown zone, and this keeps
  // the guarantee explicit at the persistence boundary.
  if (!isValidTimeZone(answers.timeZone)) {
    throw new RangeError(`Unknown IANA timezone: ${answers.timeZone}`);
  }

  const completedAt = clock.now();

  await database.$transaction(async (tx) => {
    await tx.userPreferences.upsert({
      where: { userId },
      create: {
        userId,
        timeZone: answers.timeZone,
        locale: answers.locale,
        morningNotificationMinute: answers.morningNotificationMinute,
        middayNotificationMinute: answers.middayNotificationMinute,
        eveningNotificationMinute: answers.eveningNotificationMinute,
      },
      update: {
        timeZone: answers.timeZone,
        locale: answers.locale,
        morningNotificationMinute: answers.morningNotificationMinute,
        middayNotificationMinute: answers.middayNotificationMinute,
        eveningNotificationMinute: answers.eveningNotificationMinute,
      },
    });

    await tx.planningPreferences.upsert({
      where: { userId },
      create: {
        userId,
        preferredPlanningMinute: answers.preferredPlanningMinute,
        defaultTaskDurationMinutes: answers.defaultTaskDurationMinutes,
        autonomyLevel: answers.autonomyLevel,
      },
      update: {
        preferredPlanningMinute: answers.preferredPlanningMinute,
        defaultTaskDurationMinutes: answers.defaultTaskDurationMinutes,
        autonomyLevel: answers.autonomyLevel,
      },
    });

    // Availability is a set, replaced wholesale: editing it later must not stack
    // duplicate blocks on top of the originals.
    await tx.workingHoursBlock.deleteMany({ where: { userId } });
    await tx.workingHoursBlock.createMany({
      data: WORKING_WEEKDAYS.map((weekday) => ({
        userId,
        weekday,
        startMinute: answers.workingStartMinute,
        endMinute: answers.workingEndMinute,
      })),
    });

    await tx.user.update({
      where: { id: userId },
      data: { onboardingCompletedAt: completedAt },
    });
  });

  return { completedAt, timeZone: answers.timeZone };
};

/** True when the account still has to answer the onboarding questions. */
export const needsOnboarding = async (
  database: DatabaseClient,
  userId: string,
): Promise<boolean> => {
  const user = await database.user.findUnique({
    where: { id: userId },
    select: { onboardingCompletedAt: true },
  });

  return user?.onboardingCompletedAt == null;
};
