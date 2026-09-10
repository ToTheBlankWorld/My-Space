import Link from 'next/link';
import type { CSSProperties } from 'react';

import { Badge } from '@space/ui';

import { longDate, nextDate, PLAN_MODE_LABEL, previousDate, yearOf } from '@/lib/day-view';
import { AUTONOMY_LABEL } from '@/lib/day-view';
import type { SpaceDayData } from '@/server/space';

import { PlanMyDay } from './plan-my-day';
import { ScheduleHealth } from './schedule-health';
import { Timeline } from './timeline';
import { Pool } from './pool';
import { AutonomyChanges } from './autonomy-changes';

interface DayWorkspaceProps {
  data: SpaceDayData;
}

const riseDelay = (milliseconds: number): CSSProperties =>
  ({ '--rise-delay': `${milliseconds}ms` }) as CSSProperties;

/**
 * The premium day workspace: a deterministic, server-rendered composition of the
 * authoritative day state. Interactive islands (plan, pool, task rows) sit on
 * top of server data and re-read it after every mutation.
 */
export const DayWorkspace = ({ data }: DayWorkspaceProps) => {
  const { day } = data;
  const mode = day.latestPlan?.mode;
  const todayHref = '/space';

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-b border-border/70 pb-6">
        <div>
          <p className="font-mono text-xs tracking-[0.14em] text-muted-foreground uppercase">
            Space · {day.timeZone}
          </p>
          <h1 className="mt-2 text-4xl font-medium tracking-[-0.035em] text-balance">
            {longDate(day.date)}
            <span aria-hidden className="ml-3 text-xl text-muted-foreground">
              {yearOf(day.date)}
            </span>
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {data.isToday ? <Badge variant="accent">Today</Badge> : null}
            <Badge variant="outline">Revision {day.planVersion}</Badge>
            <Badge variant="outline">{mode ? PLAN_MODE_LABEL[mode] : 'Not planned yet'}</Badge>
            <Badge variant="outline">{AUTONOMY_LABEL[data.autonomy]}</Badge>
          </div>
        </div>

        <div className="flex flex-col items-end gap-4">
          <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
            <Link
              className="rounded-md px-2 py-1 transition-colors hover:bg-muted hover:text-foreground"
              href={`/space/${previousDate(day.date)}`}
              aria-label="Previous day"
            >
              ←
            </Link>
            <Link
              className="rounded-md px-2 py-1 transition-colors hover:bg-muted hover:text-foreground"
              href={todayHref}
              aria-current={data.isToday ? 'true' : undefined}
            >
              Today
            </Link>
            <Link
              className="rounded-md px-2 py-1 transition-colors hover:bg-muted hover:text-foreground"
              href={`/space/${nextDate(day.date)}`}
              aria-label="Next day"
            >
              →
            </Link>
          </div>
          <PlanMyDay date={day.date} />
        </div>
      </header>

      <div className="animate-rise mt-6" style={riseDelay(40)}>
        <ScheduleHealth day={day} />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="animate-rise" style={riseDelay(100)}>
          <Timeline day={day} nowMinute={data.nowMinute} />
        </div>

        <div className="animate-rise space-y-10" style={riseDelay(160)}>
          <Pool date={day.date} spaceId={day.spaceId} items={day.unscheduled} />
          <AutonomyChanges actions={data.agentActions} timeZone={day.timeZone} />
        </div>
      </div>
    </div>
  );
};
