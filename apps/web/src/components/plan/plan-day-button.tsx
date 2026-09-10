'use client';

import { Button } from '@space/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface PlanDayButtonProps {
  date: string;
}

/**
 * The single "plan this day" control.
 *
 * POSTs `/api/plan`, then refreshes the route data so the page re-reads the
 * authoritative persisted day (`getDayState`) rather than trusting the response.
 * Duplicate in-flight clicks coalesce inside the service, so spamming the button
 * cannot enqueue several passes.
 */
export const PlanDayButton = ({ date }: PlanDayButtonProps) => {
  const router = useRouter();
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runPlan = async () => {
    setPlanning(true);
    setError(null);
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

      router.refresh();
    } catch {
      setError('Planning failed.');
    } finally {
      setPlanning(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={() => void runPlan()}
        disabled={planning}
      >
        {planning ? 'Planning…' : 'Plan day'}
      </Button>
      {error ? <p className="text-sm text-muted-foreground">{error}</p> : null}
    </div>
  );
};
