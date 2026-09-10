'use client';

import { Flag, Clock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { cn } from '@space/ui';
import type { TaskPriority } from '@space/types';

import { completeTask, setTaskPriority } from '@/actions/tasks';
import type { TaskActionResult } from '@/actions/tasks';
import { timeOf } from '@/lib/day-view';

const PRIORITY_CYCLE: readonly TaskPriority[] = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];

const nextPriority = (current: TaskPriority): TaskPriority => {
  const index = PRIORITY_CYCLE.indexOf(current);
  return PRIORITY_CYCLE[(index + 1) % PRIORITY_CYCLE.length] ?? 'NORMAL';
};

const flagClass = (priority: TaskPriority): string => {
  if (priority === 'CRITICAL') return 'text-danger';
  if (priority === 'HIGH') return 'text-warning';
  return 'text-muted-foreground';
};

export interface TimelineBlockProps {
  kind: 'TASK' | 'REMINDER' | 'CALENDAR_EVENT';
  itemId: string;
  title: string;
  priority: TaskPriority | null;
  start: Date | null;
  end: Date | null;
  timeZone: string;
  date: string;
}

/**
 * One block on the positioned timeline.
 *
 * Tasks are interactive (complete, re-prioritise); calendar events and reminders
 * are anchors rendered exactly as their source rows recorded them.
 */
export const TimelineBlock = ({
  kind,
  itemId,
  title,
  priority,
  start,
  end,
  timeZone,
  date,
}: TimelineBlockProps) => {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [optimisticComplete, setOptimisticComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAnchor = kind !== 'TASK' || priority === null;
  const timeLabel = `${timeOf(start, timeZone)}${end ? `–${timeOf(end, timeZone)}` : ''}`;

  const run = (action: (form: FormData) => Promise<TaskActionResult>, form: FormData) => {
    setError(null);
    startTransition(async () => {
      const result = await action(form);
      if (!result.ok) {
        setError(result.error ?? 'Could not update this item.');
        return;
      }
      router.refresh();
    });
  };

  const form = new FormData();
  form.set('id', itemId);
  form.set('date', date);

  return (
    <div
      className={cn(
        'flex h-full w-full items-center gap-2 overflow-hidden rounded-lg border px-3',
        isAnchor
          ? 'border-border-strong bg-muted'
          : 'border-border bg-surface hover:border-border-strong',
      )}
    >
      {!isAnchor && priority ? (
        <input
          type="checkbox"
          aria-label={`Mark “${title}” complete`}
          checked={optimisticComplete}
          onChange={() => {
            setOptimisticComplete(true);
            run(completeTask, form);
          }}
          disabled={pending}
          className="size-4 shrink-0 cursor-pointer rounded border-border-strong bg-surface accent-foreground disabled:cursor-wait"
        />
      ) : null}

      {!isAnchor && priority ? (
        <button
          type="button"
          aria-label="Change priority"
          onClick={() => {
            const priorityForm = new FormData();
            priorityForm.set('id', itemId);
            priorityForm.set('date', date);
            priorityForm.set('priority', nextPriority(priority));
            run(setTaskPriority, priorityForm);
          }}
          disabled={pending}
          className="shrink-0 rounded-sm p-0.5 opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait"
        >
          <Flag aria-hidden className={cn('size-3.5', flagClass(priority))} />
        </button>
      ) : null}

      <div className="min-w-0 flex-1 truncate">
        <p className="truncate text-sm leading-snug font-medium text-foreground">{title}</p>
      </div>

      <span className="flex shrink-0 items-center gap-1 font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
        {isAnchor ? (
          <>
            <Clock aria-hidden className="size-3" />
            {timeLabel}
          </>
        ) : (
          timeLabel
        )}
      </span>

      {error ? (
        <p className="sr-only" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
};
