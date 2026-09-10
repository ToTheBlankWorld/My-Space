import { cn, StatusDot } from '@space/ui';
import type { DayState, PlanMode } from '@space/planning';

import { durationLabel, focusMinutes, PLAN_MODE_LABEL } from '@/lib/day-view';

/**
 * A glanceable readout of the day's state. Every figure is derived from the
 * authoritative day buckets — never a client-side tally — so it always agrees
 * with the timeline below it.
 */

interface ScheduleHealthProps {
  day: DayState;
}

const Stat = ({
  label,
  value,
  tone = 'accent',
  hint,
}: {
  label: string;
  value: string;
  tone?: 'accent' | 'neutral' | 'success' | 'warning' | 'danger';
  hint?: string;
}) => (
  <div className="rounded-xl border border-border bg-surface px-4 py-3.5">
    <p className="flex items-center gap-1.5 font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
      <StatusDot tone={tone} />
      {label}
    </p>
    <p className="mt-1.5 text-2xl font-medium tracking-[-0.02em] tabular-nums">{value}</p>
    {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
  </div>
);

export const ScheduleHealth = ({ day }: ScheduleHealthProps) => {
  const focus = Math.round(focusMinutes(day.planned));
  const meetings = day.planned.filter((item) => item.kind === 'CALENDAR_EVENT').length;
  const placedTasks = day.planned.filter((item) => item.kind === 'TASK').length;
  const conflicts = day.latestPlan?.conflicts.length ?? 0;
  const open = day.unscheduled.length;
  const mode: PlanMode | undefined = day.latestPlan?.mode;

  return (
    <section aria-label="Day at a glance" className="mt-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Focus"
          value={focus > 0 ? durationLabel(focus) : '—'}
          tone={focus > 0 ? 'accent' : 'neutral'}
          hint="Planned work on the timeline"
        />
        <Stat
          label="Tasks placed"
          value={String(placedTasks)}
          tone="neutral"
          hint={`${open} still in the pool`}
        />
        <Stat
          label="Conflicts"
          value={conflicts > 0 ? String(conflicts) : 'None'}
          tone={conflicts > 0 ? 'danger' : 'success'}
          hint={conflicts > 0 ? 'Review to resolve' : 'Nothing overlapping'}
        />
        <Stat
          label="Meetings"
          value={meetings > 0 ? String(meetings) : '—'}
          tone="neutral"
          hint="Calendar anchors are fixed"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <span
          className={cn(
            'font-mono text-xs tracking-[0.14em] uppercase',
            day.planVersion > 0 ? 'text-muted-foreground' : 'text-muted-foreground/70',
          )}
        >
          {day.planVersion > 0
            ? `Revision ${day.planVersion} · ${PLAN_MODE_LABEL[mode ?? 'applied']}`
            : 'Not planned yet'}
        </span>
        <span className="font-mono text-xs tracking-[0.14em] text-muted-foreground/70 uppercase">
          {day.timeZone}
        </span>
        {day.plannedAt ? (
          <span className="font-mono text-xs text-muted-foreground/70 tabular-nums">
            Last planned{' '}
            {new Intl.DateTimeFormat('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            }).format(day.plannedAt)}
          </span>
        ) : null}
      </div>
    </section>
  );
};
