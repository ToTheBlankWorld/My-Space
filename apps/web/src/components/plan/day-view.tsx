import type { DayState } from '@space/planning';
import { addCalendarDays } from '@space/time';
import Link from 'next/link';

import { PlanDayButton } from './plan-day-button';

/**
 * Renders the authoritative day returned by the planning service.
 *
 * A Server Component: every number shown is persisted state (`getDayState`),
 * re-read after each plan click, so it never reflects a optimistic local guess.
 * Calendar events render as anchors that the plan cannot move.
 */

interface DayViewProps {
  day: DayState;
}

const timeOf = (value: Date | null, timeZone: string): string => {
  if (!value) {
    return '–';
  }
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
};

const friendlyDate = (date: string): string => {
  const [year, month, day] = date.split('-').map(Number);
  const safeYear = year ?? 0;
  const safeMonth = month ?? 1;
  const safeDay = day ?? 1;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(Date.UTC(safeYear, safeMonth - 1, safeDay)));
};

const MODE_LABEL = {
  applied: 'Applied',
  'ask-before-changing': 'Suggestions only',
  'suggest-only': 'Preview only',
} as const;

export const DayView = ({ day }: DayViewProps) => {
  const previous = addCalendarDays(day.date, -1);
  const next = addCalendarDays(day.date, 1);

  return (
    <main id="main" className="mx-auto w-full max-w-3xl px-6 pt-14 pb-24">
      <div className="flex items-end justify-between gap-6">
        <div>
          <p className="font-mono text-xs tracking-[0.14em] text-muted-foreground uppercase">
            Stage 06 — Plan My Day
          </p>
          <h1 className="mt-3 text-3xl font-medium tracking-[-0.03em] text-balance">
            {friendlyDate(day.date)}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {day.planVersion > 0
              ? `Revision ${day.planVersion} · ${MODE_LABEL[day.latestPlan?.mode ?? 'applied']}`
              : 'Not planned yet'}
            {day.timeZone !== 'UTC' ? ` · ${day.timeZone}` : ''}
          </p>
        </div>
        <PlanDayButton date={day.date} />
      </div>

      <div className="mt-8 flex items-center gap-2 font-mono text-xs text-muted-foreground">
        {previous ? (
          <Link className="hover:text-foreground" href={`/space/${previous}`}>
            ← Previous
          </Link>
        ) : null}
        <Link className="hover:text-foreground" href="/space">
          Today
        </Link>
        {next ? (
          <Link className="hover:text-foreground" href={`/space/${next}`}>
            Next →
          </Link>
        ) : null}
      </div>

      <section aria-label="Timeline" className="mt-8">
        <h2 className="font-mono text-xs tracking-[0.16em] text-muted-foreground uppercase">Day</h2>
        {day.planned.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Nothing on the day yet. Plan it to place your open tasks.
          </p>
        ) : (
          <ol className="mt-3 space-y-2">
            {day.planned.map((item) => (
              <li
                key={`${item.kind}:${item.itemId}`}
                className={`flex items-baseline gap-4 rounded-lg border px-4 py-3 ${
                  item.kind === 'CALENDAR_EVENT' ? 'border-border-strong bg-muted' : 'bg-surface'
                }`}
              >
                <span className="w-24 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                  {timeOf(item.start, day.timeZone)}
                  {item.end ? `–${timeOf(item.end, day.timeZone)}` : ''}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  {item.kind !== 'CALENDAR_EVENT' && item.priority ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{item.priority}</p>
                  ) : null}
                </div>
                {item.kind === 'CALENDAR_EVENT' ? (
                  <span className="ml-auto shrink-0 font-mono text-[0.625rem] tracking-wide text-muted-foreground uppercase">
                    event
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-label="Unscheduled tasks" className="mt-10">
        <h2 className="font-mono text-xs tracking-[0.16em] text-muted-foreground uppercase">
          Unscheduled
        </h2>
        {day.unscheduled.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No unscheduled tasks.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {day.unscheduled.map((task) => (
              <li key={task.id} className="rounded-lg border border-border bg-surface px-4 py-3">
                <div className="flex items-baseline justify-between gap-4">
                  <p className="truncate text-sm font-medium">{task.title}</p>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {task.estimatedMinutes} min
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {day.latestPlan && day.latestPlan.conflicts.length > 0 ? (
        <section aria-label="Conflicts" className="mt-10">
          <h2 className="font-mono text-xs tracking-[0.16em] text-muted-foreground uppercase">
            Conflicts
          </h2>
          <ul className="mt-3 space-y-2">
            {day.latestPlan.conflicts.map((conflict) => (
              <li key={`${conflict.type}:${conflict.itemIds.join(',')}`} className="text-sm">
                <p className="font-medium">{conflict.description}</p>
                {conflict.resolution ? (
                  <p className="text-muted-foreground">{conflict.resolution}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
};
