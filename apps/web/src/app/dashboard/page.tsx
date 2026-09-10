import type { Metadata } from 'next';
import Link from 'next/link';

import { ArrowRight, Bell, CalendarClock, CheckCircle2, Inbox } from 'lucide-react';

import { Badge, StatusDot } from '@space/ui';
import { minuteOfDayAt } from '@space/time';

import { AppShell } from '@/components/app/app-shell';
import { longDate, yearOf } from '@/lib/day-view';
import { getOverview } from '@/server/overview';
import { requireOnboardedUser } from '@/server/session';
import { clock } from '@/server/clock';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Overview',
};

const periodLabel = (hour: number): string => {
  if (hour >= 18) return 'Evening';
  if (hour >= 12) return 'Afternoon';
  return 'Morning';
};

const OverviewPage = async () => {
  const { user } = await requireOnboardedUser();
  const data = await getOverview(user.id);

  const firstName = user.name?.trim().split(' ')[0] ?? 'there';
  const hour = Math.floor(minuteOfDayAt(clock.now(), data.timeZone) / 60);
  const todayHref = `/space/${data.today}`;

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 sm:px-6 lg:px-8">
        <header className="border-b border-border/70 pb-6">
          <p className="font-mono text-xs tracking-[0.14em] text-muted-foreground uppercase">
            Overview
          </p>
          <h1 className="mt-2 text-4xl font-medium tracking-[-0.035em] text-balance">
            Good {periodLabel(hour)}, {firstName}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {longDate(data.today)} {yearOf(data.today)} · {data.timeZone}
          </p>
        </header>

        <nav aria-label="Next seven days" className="mt-6">
          <ol className="flex gap-2 overflow-x-auto pb-1">
            {data.days.map((day) => {
              const isToday = day.date === data.today;
              return (
                <li key={day.date} className="shrink-0">
                  <Link
                    href={`/space/${day.date}`}
                    aria-current={isToday ? 'page' : undefined}
                    className={`flex w-16 flex-col items-center gap-1 rounded-xl border px-2 py-3 transition-colors ${
                      isToday
                        ? 'border-accent bg-accent/10 text-accent-foreground'
                        : 'border-border bg-surface text-foreground hover:border-border-strong'
                    }`}
                  >
                    <span className="font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase">
                      {isToday ? 'Today' : day.weekday}
                    </span>
                    <span className="text-xl font-medium tabular-nums">{day.date.slice(8)}</span>
                    <span
                      aria-hidden
                      className={`size-1.5 rounded-full ${
                        day.planned ? 'bg-accent' : 'bg-transparent'
                      }`}
                      title={day.planned ? 'Planned' : undefined}
                    />
                  </Link>
                </li>
              );
            })}
          </ol>
        </nav>

        <section
          aria-label="Work status"
          className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          <Link
            href={todayHref}
            className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-border-strong"
          >
            <div className="flex items-center justify-between gap-4">
              <p className="flex items-center gap-1.5 font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
                <CheckCircle2 aria-hidden className="size-3.5" />
                Today
              </p>
              <StatusDot tone={data.todayPlanned ? 'success' : 'neutral'} />
            </div>
            <p className="mt-2 text-lg font-medium">
              {data.todayPlanned ? 'Planned' : 'Not planned yet'}
            </p>
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              Open the day{' '}
              <ArrowRight
                aria-hidden
                className="size-3 transition-transform group-hover:translate-x-0.5"
              />
            </p>
          </Link>

          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="flex items-center gap-1.5 font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
              <Inbox aria-hidden className="size-3.5" />
              Overdue
            </p>
            <p className="mt-2 text-lg font-medium tabular-nums">{data.overdue}</p>
            <p className="mt-1 text-xs text-muted-foreground">Open tasks past their deadline</p>
          </div>

          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="flex items-center gap-1.5 font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
              <CalendarClock aria-hidden className="size-3.5" />
              With deadlines
            </p>
            <p className="mt-2 text-lg font-medium tabular-nums">{data.due}</p>
            <p className="mt-1 text-xs text-muted-foreground">Open tasks that carry a due date</p>
          </div>

          <Link
            href="/notifications"
            className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-border-strong"
          >
            <p className="flex items-center gap-1.5 font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
              <Bell aria-hidden className="size-3.5" />
              Unread
            </p>
            <div className="mt-2 flex items-baseline justify-between gap-3">
              <p className="text-lg font-medium tabular-nums">{data.unread}</p>
              <Badge variant={data.unread > 0 ? 'accent' : 'outline'}>
                {data.unread > 0 ? 'Inbox' : 'All caught up'}
              </Badge>
            </div>
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              View notifications
              <ArrowRight
                aria-hidden
                className="size-3 transition-transform group-hover:translate-x-0.5"
              />
            </p>
          </Link>
        </section>

        <section aria-label="Quick links" className="mt-8">
          <h2 className="text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase">
            Your space
          </h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Link
              href={todayHref}
              className="rounded-xl border border-border bg-surface px-5 py-4 transition-colors hover:border-border-strong"
            >
              <p className="text-sm font-medium">Today&apos;s plan</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Timeline, pool, and why it changed
              </p>
            </Link>
            <Link
              href="/calendar"
              className="rounded-xl border border-border bg-surface px-5 py-4 transition-colors hover:border-border-strong"
            >
              <p className="text-sm font-medium">Calendar</p>
              <p className="mt-1 text-xs text-muted-foreground">Your events across the week</p>
            </Link>
            <Link
              href="/settings"
              className="rounded-xl border border-border bg-surface px-5 py-4 transition-colors hover:border-border-strong"
            >
              <p className="text-sm font-medium">Settings</p>
              <p className="mt-1 text-xs text-muted-foreground">Autonomy level and notifications</p>
            </Link>
          </div>
        </section>
      </div>
    </AppShell>
  );
};

export default OverviewPage;
