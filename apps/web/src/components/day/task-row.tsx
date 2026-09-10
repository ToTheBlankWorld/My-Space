'use client';

import { Flag, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '@space/ui';
import type { TaskPriority } from '@space/types';

import { cancelTask, completeTask, setTaskPriority } from '@/actions/tasks';
import type { TaskActionResult } from '@/actions/tasks';
import { PRIORITY_LABEL } from '@/lib/day-view';

const PRIORITY_CYCLE: readonly TaskPriority[] = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];

const nextPriority = (current: TaskPriority): TaskPriority => {
  const index = PRIORITY_CYCLE.indexOf(current);
  return PRIORITY_CYCLE[(index + 1) % PRIORITY_CYCLE.length] ?? 'NORMAL';
};

const priorityFlagClass = (priority: TaskPriority): string => {
  if (priority === 'CRITICAL') return 'text-danger';
  if (priority === 'HIGH') return 'text-warning';
  if (priority === 'NORMAL') return 'text-muted-foreground';
  return 'text-muted-foreground/50';
};

export interface TaskRowProps extends ComponentPropsWithoutRef<'li'> {
  taskId: string;
  title: string;
  priority: TaskPriority;
  date: string;
  timeLabel?: string;
  meta?: string;
  /** Allow removal (solely used in the day's pool, never for placed timeline work). */
  removable?: boolean;
}

/**
 * One task row with complete / priority / cancel controls.
 *
 * Every control is a small form posting a Server Action — the authoritative
 * write is the repository, not a local copy. Optimistic moves are limited to the
 * tiny visual layer (the check flip) and the route is refreshed from the server
 * on completion, so a racing write can never paint a lie for long.
 */
export const TaskRow = ({
  taskId,
  title,
  priority,
  date,
  timeLabel,
  meta,
  removable = false,
  className,
  ...props
}: TaskRowProps) => {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [optimisticComplete, setOptimisticComplete] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = (action: (form: FormData) => Promise<TaskActionResult>, formData: FormData) => {
    setError(null);
    startTransition(async () => {
      const result = await action(formData);
      if (!result.ok) {
        setError(result.error ?? 'That change could not be saved.');
        setOptimisticComplete(false);
        return;
      }
      router.refresh();
    });
  };

  const completeForm = new FormData();
  completeForm.set('id', taskId);
  completeForm.set('date', date);

  const cancelForm = new FormData();
  cancelForm.set('id', taskId);
  cancelForm.set('date', date);

  return (
    <li
      className={cn(
        'group flex items-center gap-3 border-b border-border/70 py-2 first:border-t',
        className,
      )}
      {...props}
    >
      <input
        type="checkbox"
        aria-label={`Mark “${title}” complete`}
        checked={optimisticComplete}
        onChange={() => {
          setOptimisticComplete(true);
          run(completeTask, completeForm);
        }}
        disabled={pending}
        className="size-4 shrink-0 cursor-pointer rounded border-border-strong bg-surface accent-foreground disabled:cursor-wait"
      />

      <button
        type="button"
        aria-label={`Priority: ${PRIORITY_LABEL[priority]}. Change priority`}
        title={`Priority: ${PRIORITY_LABEL[priority]}`}
        onClick={() => {
          const form = new FormData();
          form.set('id', taskId);
          form.set('date', date);
          form.set('priority', nextPriority(priority));
          run(setTaskPriority, form);
        }}
        disabled={pending}
        className="shrink-0 rounded-sm p-0.5 opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait"
      >
        <Flag aria-hidden className={cn('size-4', priorityFlagClass(priority))} />
      </button>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        {(timeLabel ?? meta) && (
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground tabular-nums">
            {timeLabel ?? meta}
          </p>
        )}
      </div>

      {error ? (
        <p className="sr-only" role="status">
          {error}
        </p>
      ) : null}

      {removable ? (
        <AnimatePresence initial={false} mode="popLayout">
          {confirmingCancel ? (
            <motion.div
              key="confirm"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.14, ease: 'easeOut' }}
              className="flex items-center gap-1"
            >
              <button
                type="button"
                onClick={() => {
                  if (confirmTimer.current) clearTimeout(confirmTimer.current);
                  run(cancelTask, cancelForm);
                }}
                disabled={pending}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:cursor-wait"
              >
                <X aria-hidden className="size-3.5" /> Cancel task
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirmTimer.current) clearTimeout(confirmTimer.current);
                  setConfirmingCancel(false);
                }}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Keep
              </button>
            </motion.div>
          ) : (
            <motion.div
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14 }}
            >
              <button
                type="button"
                aria-label={`Cancel “${title}”`}
                onClick={() => {
                  setConfirmingCancel(true);
                  confirmTimer.current = setTimeout(() => setConfirmingCancel(false), 4000);
                }}
                disabled={pending}
                className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 disabled:cursor-wait md:opacity-0"
              >
                <X aria-hidden className="size-4" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      ) : null}
    </li>
  );
};
