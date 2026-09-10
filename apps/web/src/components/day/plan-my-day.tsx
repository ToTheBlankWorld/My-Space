'use client';

import { CalendarCheck2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@space/ui';
import type { PlanMode } from '@space/planning';

import { PLAN_MODE_LABEL } from '@/lib/day-view';

interface PlanResult {
  mode: PlanMode;
  applied: boolean;
  scheduled: number;
  unscheduled: number;
}

interface PlanMyDayProps {
  date: string;
}

/**
 * The single "plan this day" control, now with an inline result readout.
 *
 * POSTs `/api/plan`, shows the bounded summary, then refreshes the route so the
 * page re-renders from the authoritative persisted day. The live region keeps
 * the outcome audible to assistive technology without a page navigation.
 */
export const PlanMyDay = ({ date }: PlanMyDayProps) => {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<PlanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runPlan = () => {
    setError(null);
    setResult(null);

    startTransition(async () => {
      try {
        const response = await fetch('/api/plan', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ date }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? 'Planning failed.');
          return;
        }

        const body = (await response.json()) as PlanResult;
        setResult(body);
        router.refresh();
      } catch {
        setError('Planning failed.');
      }
    });
  };

  const summary =
    result &&
    `Planned · ${result.scheduled} placed · ${result.unscheduled} still open · ${PLAN_MODE_LABEL[result.mode]}`;

  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="primary"
        onClick={runPlan}
        disabled={pending}
        className="gap-2"
      >
        {pending ? (
          <>
            <span
              aria-hidden
              className="size-3.5 animate-spin rounded-full border-2 border-background/40 border-t-background"
            />
            Planning…
          </>
        ) : (
          <>
            <CalendarCheck2 aria-hidden className="size-4" />
            Plan my day
          </>
        )}
      </Button>

      <AnimatePresence initial={false} mode="popLayout">
        {(error ?? summary) && (
          <motion.p
            key={error ?? summary}
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="min-w-0 text-sm text-muted-foreground"
          >
            {error ?? summary}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
};
