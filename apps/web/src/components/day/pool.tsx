'use client';

import { Inbox, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import type { FormEvent } from 'react';

import { EmptyState } from '@space/ui';
import type { DayTask } from '@space/planning';

import { createTask } from '@/actions/tasks';
import type { TaskActionResult } from '@/actions/tasks';
import { durationLabel } from '@/lib/day-view';

import { TaskRow } from './task-row';

interface PoolProps {
  date: string;
  spaceId: string;
  items: DayTask[];
}

/**
 * The day's open work — tasks not yet placed on the timeline.
 *
 * Quick-add prepends into today's space so the next plan pass schedules it;
 * each row offers complete / priority / cancel through the same task actions
 * the timeline uses.
 */
export const Pool = ({ date, spaceId, items }: PoolProps) => {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const title = new FormData(form).get('title');
    if (typeof title !== 'string' || title.trim() === '') return;

    setError(null);
    startTransition(async () => {
      const data = new FormData();
      data.set('date', date);
      data.set('spaceId', spaceId);
      data.set('title', title);
      const result: TaskActionResult = await createTask(data);
      if (!result.ok) {
        setError(result.error ?? 'The task could not be added.');
        return;
      }
      if (inputRef.current) inputRef.current.value = '';
      router.refresh();
    });
  };

  return (
    <section aria-labelledby="pool-heading">
      <div className="flex items-baseline justify-between gap-4">
        <h2
          id="pool-heading"
          className="text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase"
        >
          Pool
        </h2>
        <p className="font-mono text-xs text-muted-foreground tabular-nums">{items.length} open</p>
      </div>

      <form onSubmit={submit} className="mt-3">
        <label className="sr-only" htmlFor="pool-task-title">
          Add a task to today&apos;s pool
        </label>
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 focus-within:ring-2 focus-within:ring-ring">
          <Plus aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            id="pool-task-title"
            name="title"
            type="text"
            autoComplete="off"
            placeholder="Add to today's pool and press Enter"
            disabled={pending}
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-wait"
          />
        </div>
      </form>

      {error ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {error}
        </p>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          className="mt-3 rounded-xl border border-border"
          icon={<Inbox aria-hidden className="size-5" />}
          title="Today's pool is clear"
          description="Anything you add below will be placed next time you plan the day."
        />
      ) : (
        <div className="mt-3 rounded-xl border border-border bg-surface px-4">
          <ul className="divide-y divide-border/50">
            {items.map((task) => (
              <TaskRow
                key={task.id}
                taskId={task.id}
                title={task.title}
                priority={task.priority}
                date={date}
                meta={task.estimatedMinutes ? durationLabel(task.estimatedMinutes) : undefined}
                removable
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};
