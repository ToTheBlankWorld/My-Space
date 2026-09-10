import {
  AlarmClock,
  ArrowRightLeft,
  BellRing,
  CalendarPlus,
  CheckCircle2,
  ClipboardList,
  Clock3,
  CircleDot,
  RefreshCcw,
  Scale,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { EmptyState, StatusDot } from '@space/ui';

import type { AgentActionView } from '@/server/space';
import { timeOf } from '@/lib/day-view';

const ACTION_META: Record<string, { label: string; icon: LucideIcon }> = {
  SPACE_PLANNED: { label: 'Day planned', icon: ClipboardList },
  TASK_SCHEDULED: { label: 'Task scheduled', icon: CalendarPlus },
  TASK_RESCHEDULED: { label: 'Task rescheduled', icon: ArrowRightLeft },
  TASK_DEFERRED: { label: 'Task deferred', icon: Clock3 },
  CONFLICT_RESOLVED: { label: 'Conflict resolved', icon: CheckCircle2 },
  WORKLOAD_BALANCED: { label: 'Workload balanced', icon: Scale },
  DEADLINE_ENFORCED: { label: 'Deadline protected', icon: AlarmClock },
  CALENDAR_RECONCILED: { label: 'Calendar reconciled', icon: RefreshCcw },
  NOTIFICATION_DISPATCHED: { label: 'Notification sent', icon: BellRing },
};

const outcomeTone = (outcome: string): 'success' | 'neutral' | 'danger' => {
  if (outcome === 'FAILED') return 'danger';
  if (outcome === 'SKIPPED') return 'neutral';
  return 'success';
};

const movedToLabel = (view: AgentActionView, timeZone: string): string | null => {
  if (view.scheduledStart) {
    return `→ ${timeOf(new Date(view.scheduledStart), timeZone)}`;
  }
  return null;
};

interface AutonomyChangesProps {
  actions: AgentActionView[];
  timeZone: string;
  windowLabel?: string;
}

/**
 * Why the day looks the way it does — the deterministic decisions the autonomy
 * layer persisted, newest last, as `AgentAction` rows scoped to this space.
 */
export const AutonomyChanges = ({ actions, timeZone, windowLabel }: AutonomyChangesProps) => {
  const visible = actions.filter((action) => action.outcome !== 'SKIPPED').slice(0, 12);

  return (
    <section aria-labelledby="autonomy-heading">
      <div className="flex items-baseline justify-between gap-4">
        <h2
          id="autonomy-heading"
          className="text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase"
        >
          What Space changed
        </h2>
        {windowLabel ? (
          <p className="font-mono text-xs text-muted-foreground">{windowLabel}</p>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          className="mt-3 rounded-xl border border-border"
          title="Nothing has changed here"
          description="When Space plans or rebalances this day, its decisions will appear here with the reason for each one."
        />
      ) : (
        <ol className="mt-3 divide-y divide-border/50 rounded-xl border border-border bg-surface px-4">
          {visible.map((action) => {
            const meta = ACTION_META[action.actionType] ?? {
              label: action.actionType.replaceAll('_', ' ').toLowerCase(),
              icon: CircleDot,
            };
            const Icon = meta.icon;
            const movedTo = movedToLabel(action, timeZone);

            return (
              <li key={action.id} className="flex items-start gap-3 py-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Icon aria-hidden className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {meta.label}
                    {movedTo ? (
                      <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
                        {movedTo}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {action.reason}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
                    {timeOf(new Date(action.occurredAt), timeZone)}
                  </span>
                  <StatusDot
                    tone={outcomeTone(action.outcome)}
                    label={action.outcome.toLowerCase()}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
};
