'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { cn } from '@space/ui';
import type { AutonomyLevel } from '@space/types';
import { AUTONOMY_LEVELS } from '@space/types';

import { setAutonomyLevel } from '@/actions/preferences';
import type { PreferenceActionResult } from '@/actions/preferences';
import { AUTONOMY_LABEL, AUTONOMY_DESCRIPTION } from '@/lib/day-view';

/**
 * The autonomy-level selector.
 *
 * Rendered as three radio-style cards. A pick submits the server action and the
 * route is refreshed so the badge in the day workspace reflects the persisted
 * value, not the local click.
 */
export const AutonomyLevelControl = ({ value }: { value: AutonomyLevel }) => {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const choose = (next: AutonomyLevel) => {
    if (next === value) return;
    setError(null);
    const form = new FormData();
    form.set('autonomyLevel', next);
    startTransition(async () => {
      const result: PreferenceActionResult = await setAutonomyLevel(form);
      if (!result.ok) {
        setError(result.error ?? 'That setting could not be saved.');
        return;
      }
      router.refresh();
    });
  };

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Autonomy level"
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
      >
        {AUTONOMY_LEVELS.map((level) => {
          const active = level === value;
          return (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choose(level)}
              disabled={pending}
              className={cn(
                'rounded-xl border p-4 text-left transition-colors disabled:cursor-wait',
                active
                  ? 'border-accent bg-accent/10 text-accent-foreground'
                  : 'border-border bg-surface hover:border-border-strong',
              )}
            >
              <p className="text-sm font-medium">{AUTONOMY_LABEL[level]}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {AUTONOMY_DESCRIPTION[level]}
              </p>
            </button>
          );
        })}
      </div>
      {error ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
};
