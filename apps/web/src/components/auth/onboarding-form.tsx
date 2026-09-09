'use client';

import { Button } from '@space/ui';
import { AUTONOMY_LEVELS } from '@space/types';
import { useActionState, type FormEvent } from 'react';

import { type OnboardingState, saveOnboarding } from '@/actions/onboarding';

/**
 * The onboarding form.
 *
 * Collects exactly what `completeOnboarding` persists: timezone, locale,
 * working hours, preferred planning time, optional notification times, the
 * default task duration and the autonomy level. Wall-clock inputs are converted
 * to minutes-of-day before the action runs, so the server action — which is the
 * single source of truth for validation — receives the same numbers the rest of
 * the product stores.
 *
 * Times are optional where the schema says nullable; an empty box submits as a
 * null rather than as 00:00, so switching a reminder off is possible.
 */

interface OnboardingFormProps {
  readonly timeZones: readonly string[];
}

const LOCALES = [
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'ja', label: '日本語' },
  { value: 'pt', label: 'Português' },
] as const;

const AUTONOMY_DESCRIPTIONS: Record<(typeof AUTONOMY_LEVELS)[number], string> = {
  SUGGEST_ONLY: 'The engine proposes changes. Nothing moves without your say.',
  ASK_BEFORE_CHANGING: 'The engine asks for confirmation before rescheduling anything.',
  AUTOMATICALLY_MANAGE: 'The engine applies its rules and reports what it changed.',
};

const DURATION_OPTIONS = [
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 90, label: '1.5 hours' },
  { value: 120, label: '2 hours' },
] as const;

const DEFAULT_WORK_START = minutesToTime(9 * 60);
const DEFAULT_WORK_END = minutesToTime(17 * 60);
const DEFAULT_PLANNING = minutesToTime(7 * 60);

/** `HH:MM` local time from minutes since midnight, for `<input type="time">`. */
function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/** Minutes since midnight from an `HH:MM` value. Empty input is `null`. */
function timeToMinutes(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value === '') {
    return null;
  }
  const parts = value.split(':').map((part) => Number.parseInt(part, 10));
  const [hours, mins] = parts as [number, number] | [undefined, undefined];
  if (hours === undefined || mins === undefined || Number.isNaN(hours) || Number.isNaN(mins)) {
    return null;
  }
  return hours * 60 + mins;
}

const Field = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) => (
  <label className="flex flex-col gap-2">
    <span className="text-sm font-medium">{label}</span>
    {children}
    {hint !== undefined && <span className="text-sm text-muted-foreground">{hint}</span>}
  </label>
);

const inputClasses =
  'h-10 rounded-md border border-border bg-surface px-3 text-sm outline-none transition-colors focus-visible:border-border-strong';

const initial = {
  timeZone: '',
  locale: 'en',
  workingStartMinute: DEFAULT_WORK_START,
  workingEndMinute: DEFAULT_WORK_END,
  preferredPlanningMinute: DEFAULT_PLANNING,
  morningNotificationMinute: '',
  middayNotificationMinute: '',
  eveningNotificationMinute: '',
  defaultTaskDurationMinutes: '60',
  autonomyLevel: 'ASK_BEFORE_CHANGING',
};

export const OnboardingForm = ({ timeZones }: OnboardingFormProps) => {
  const [state, formAction, isPending] = useActionState<OnboardingState, FormData>(saveOnboarding, {
    error: null,
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const form = event.currentTarget;
    const values = new FormData(form);

    fillMinutes(values, 'workingStartMinute');
    fillMinutes(values, 'workingEndMinute');
    fillMinutes(values, 'preferredPlanningMinute');
    fillMinutes(values, 'morningNotificationMinute');
    fillMinutes(values, 'middayNotificationMinute');
    fillMinutes(values, 'eveningNotificationMinute');

    formAction(values);
  };

  return (
    <form action={formAction} onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <Field label="Time zone">
          <select name="timeZone" required defaultValue={initial.timeZone} className={inputClasses}>
            <option value="" disabled>
              Select…
            </option>
            {[...new Set([...timeZones, ...Intl.supportedValuesOf('timeZone')]).values()]
              .sort()
              .map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replaceAll('_', ' ')}
                </option>
              ))}
          </select>
        </Field>

        <Field label="Language">
          <select name="locale" defaultValue={initial.locale} className={inputClasses}>
            {LOCALES.map((locale) => (
              <option key={locale.value} value={locale.value}>
                {locale.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Working day starts" hint="The scheduler may place work in this range.">
          <input
            type="time"
            name="workingStartMinute"
            defaultValue={initial.workingStartMinute}
            className={inputClasses}
          />
        </Field>

        <Field label="Working day ends">
          <input
            type="time"
            name="workingEndMinute"
            defaultValue={initial.workingEndMinute}
            className={inputClasses}
          />
        </Field>

        <Field label="Plan my day at" hint="When the daily plan is produced.">
          <input
            type="time"
            name="preferredPlanningMinute"
            defaultValue={initial.preferredPlanningMinute}
            className={inputClasses}
          />
        </Field>

        <Field label="Default task length">
          <select
            name="defaultTaskDurationMinutes"
            defaultValue={initial.defaultTaskDurationMinutes}
            className={inputClasses}
          >
            {DURATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <fieldset className="flex flex-col gap-4 border-t border-border pt-6">
        <legend className="text-sm font-medium">Daily check-ins — optional</legend>
        <p className="text-sm text-muted-foreground">
          Leave a time empty to switch that check-in off. Reminders are Stage 5; onboarding only
          records the preference.
        </p>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          <Field label="Morning">
            <input
              type="time"
              name="morningNotificationMinute"
              defaultValue={initial.morningNotificationMinute}
              className={inputClasses}
            />
          </Field>
          <Field label="Midday">
            <input
              type="time"
              name="middayNotificationMinute"
              defaultValue={initial.middayNotificationMinute}
              className={inputClasses}
            />
          </Field>
          <Field label="Evening">
            <input
              type="time"
              name="eveningNotificationMinute"
              defaultValue={initial.eveningNotificationMinute}
              className={inputClasses}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4 border-t border-border pt-6">
        <legend className="text-sm font-medium">How Space should act for you</legend>

        <div className="flex flex-col gap-3" role="radiogroup" aria-label="Autonomy level">
          {AUTONOMY_LEVELS.map((level) => (
            <label key={level} className="flex cursor-pointer items-start gap-3">
              <input
                type="radio"
                name="autonomyLevel"
                value={level}
                defaultChecked={level === initial.autonomyLevel}
                className="mt-1 size-4 accent-[var(--color-accent)]"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">
                  {level
                    .split('_')
                    .map((word) => word[0] + word.slice(1).toLowerCase())
                    .join(' ')}
                </span>
                <span className="text-sm text-muted-foreground">
                  {AUTONOMY_DESCRIPTIONS[level]}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {state.error !== null && (
        <p
          role="alert"
          className="rounded-md border border-border bg-surface px-4 py-3 text-sm whitespace-pre-line text-muted-foreground"
        >
          {state.error}
        </p>
      )}

      <Button type="submit" size="lg" disabled={isPending} className="w-full sm:w-auto">
        {isPending ? 'Saving…' : 'Start with Space'}
      </Button>
    </form>
  );
};

/** Reads an `HH:MM` input and rewrites it as minutes-of-day for the action. */
function fillMinutes(values: FormData, name: string): void {
  const minutes = timeToMinutes(values.get(name) as string | null);
  if (minutes !== null) {
    values.set(name, String(minutes));
  } else {
    values.set(name, '');
  }
}
