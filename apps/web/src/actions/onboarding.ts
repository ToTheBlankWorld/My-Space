'use server';

import { AUTH_RATE_LIMITS, completeOnboarding, InMemoryRateLimiter } from '@space/auth';
import { ValidationError } from '@space/validation';
import { redirect } from 'next/navigation';

import { clock } from '@/server/clock';
import { getDatabase } from '@/server/database';
import { DASHBOARD_PATH, requireUser } from '@/server/session';

/**
 * Saves the onboarding answers and marks the account onboarded.
 *
 * The answers come from a plain HTML form (works before JavaScript, ships no
 * client bundle) and the parsed, validated record is written by
 * `completeOnboarding` inside `@space/auth` — the same transaction a settings
 * page will use later, so there is exactly one writer of these tables.
 *
 * Boundary rules in force:
 *
 * - The user id comes from the session cookie, never from the form.
 * - Input is parsed by `onboardingSchema`; an anonymous submission is redirected
 *   to the login screen before anything is written.
 * - Writes are rate-limited per user. The in-memory limiter only covers a single
 *   process; the interface is what matters here, and Stage 7 swaps the
 *   implementation without touching this call site.
 */

export interface OnboardingState {
  error: string | null;
}

const ONBOARDING_FAILED = 'Your answers could not be saved. Please review them and try again.';
const ONBOARDING_RATE_LIMITED = 'Too many attempts. Please wait a minute and try again.';

/** Reads a minute-of-day / duration field and tolerates the empty option boxes. */
const readMinuteField = (form: FormData, name: string): number | null => {
  const raw = form.get(name);
  return typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : null;
};

const toNumberField = (form: FormData, name: string, fallback: number): number => {
  const raw = form.get(name);
  return typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : fallback;
};

const toNullableNumberField = (form: FormData, name: string): number | null =>
  readMinuteField(form, name);

/** Per-process budget for onboarding writes. See `rate-limit.ts`. */
const rateLimiter = new InMemoryRateLimiter(AUTH_RATE_LIMITS.onboarding, clock);

export const saveOnboarding = async (
  _previous: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> => {
  const { user } = await requireUser();

  const decision = await rateLimiter.consume(`onboarding:${user.id}`);
  if (!decision.allowed) {
    return { error: ONBOARDING_RATE_LIMITED };
  }

  const input = {
    timeZone: formData.get('timeZone'),
    locale: formData.get('locale') ?? 'en',
    workingStartMinute: toNumberField(formData, 'workingStartMinute', 9 * 60),
    workingEndMinute: toNumberField(formData, 'workingEndMinute', 17 * 60),
    preferredPlanningMinute: toNumberField(formData, 'preferredPlanningMinute', 7 * 60),
    morningNotificationMinute: toNullableNumberField(formData, 'morningNotificationMinute'),
    middayNotificationMinute: toNullableNumberField(formData, 'middayNotificationMinute'),
    eveningNotificationMinute: toNullableNumberField(formData, 'eveningNotificationMinute'),
    defaultTaskDurationMinutes: toNumberField(formData, 'defaultTaskDurationMinutes', 60),
    autonomyLevel: formData.get('autonomyLevel'),
  };

  try {
    await completeOnboarding({ database: getDatabase(), clock, userId: user.id, input });
  } catch (error) {
    if (error instanceof ValidationError) {
      // The message carries every issue as `path: reason` lines; the form shows
      // it in full so the user can see exactly what to correct.
      return { error: `${ONBOARDING_FAILED}\n${error.issues.join('\n')}` };
    }
    throw error;
  }

  // Outside the try: `redirect` signals by throwing, and catching it would turn
  // a successful save into an error message.
  redirect(DASHBOARD_PATH);
};
