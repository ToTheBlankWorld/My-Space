import type { Metadata } from 'next';

import { CalendarX2, MapPin, Radio } from 'lucide-react';

import { EmptyState, StatusDot } from '@space/ui';

import { AppShell } from '@/components/app/app-shell';
import { ConnectCalendar } from '@/components/calendar/connect-calendar';
import { DisconnectCalendar } from '@/components/calendar/disconnect-calendar';
import { longDate, timeOf, yearOf } from '@/lib/day-view';
import { getCalendarSummary, type CalendarSummaryData } from '@/server/calendar-summary';
import { requireOnboardedUser } from '@/server/session';
import { toCalendarDate } from '@space/time';
import { clock } from '@/server/clock';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Calendar',
};

const statusTone = (status: string): 'success' | 'warning' | 'neutral' | 'danger' => {
  if (status === 'CONNECTED') return 'success';
  if (status === 'ERROR') return 'danger';
  return 'neutral';
};

const eventRange = (
  event: CalendarSummaryData['days'][number]['events'][number],
  timeZone: string,
): string => {
  if (event.allDay) return 'All day';
  const start = timeOf(new Date(event.startAt), timeZone);
  const end = timeOf(new Date(event.endAt), timeZone);
  return `${start}–${end}`;
};

const CalendarPage = async () => {
  const { user } = await requireOnboardedUser();
  const summary = await getCalendarSummary(user.id);
  const timeZone = summary.timeZone;
  const today = toCalendarDate(clock.now(), timeZone);
  const hasConnection = summary.connections.some((connection) => connection.status === 'CONNECTED');

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl px-4 pt-8 sm:px-6 lg:px-8">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border/70 pb-6">
          <div>
            <h1 className="text-3xl font-medium tracking-[-0.035em] text-balance">Calendar</h1>
            <p className="mt-2 font-mono text-xs tracking-[0.14em] text-muted-foreground uppercase">
              Events, synced · {timeZone}
            </p>
          </div>
        </header>

        <section
          aria-label="Connections"
          className="mt-6 rounded-xl border border-border bg-surface"
        >
          {summary.connections.length > 0 ? (
            <ul className="divide-y divide-border/50">
              {summary.connections.map((connection) => (
                <li
                  key={connection.id}
                  className="flex items-center justify-between gap-4 px-5 py-4"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <Radio aria-hidden className="size-4" />
                    </span>
                    <div>
                      <p className="flex items-center gap-2 text-sm font-medium">
                        Google Calendar
                        <StatusDot
                          tone={statusTone(connection.status)}
                          label={connection.status.toLowerCase()}
                        />
                      </p>
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {connection.providerAccountId} · {connection.calendarCount} calendar
                        {connection.calendarCount === 1 ? '' : 's'}
                        {connection.lastSyncedAt
                          ? ` · synced ${timeOf(new Date(connection.lastSyncedAt), timeZone)}`
                          : ''}
                      </p>
                    </div>
                  </div>
                  <DisconnectCalendar connectionId={connection.id} />
                </li>
              ))}
            </ul>
          ) : summary.hasOAuthConfig ? (
            <div className="flex flex-col items-start gap-3 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">No calendar connected</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Your real meetings become the anchors the planner works around.
                </p>
              </div>
              <ConnectCalendar />
            </div>
          ) : (
            <div className="px-5 py-5">
              <p className="text-sm font-medium">Calendar sync is not configured</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Connect a Google account in the environment to see your events here.
              </p>
            </div>
          )}
        </section>

        <section aria-labelledby="upcoming-heading" className="mt-8">
          <h2
            id="upcoming-heading"
            className="text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase"
          >
            Next seven days
          </h2>

          {!hasConnection ? (
            <EmptyState
              className="mt-3 rounded-xl border border-border"
              icon={<CalendarX2 aria-hidden className="size-5" />}
              title="No events mirrored yet"
              description="Once a calendar is connected and synced, its events show up here day by day."
            />
          ) : (
            <ol className="mt-3 space-y-6">
              {summary.days.map((day) => {
                const isToday = day.date === today;
                return (
                  <li key={day.date}>
                    <div className="flex items-baseline justify-between border-b border-border/50 pb-2">
                      <p className="font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
                        {isToday ? 'Today' : `${longDate(day.date)} ${yearOf(day.date)}`}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground tabular-nums">
                        {day.events.length} event{day.events.length === 1 ? '' : 's'}
                      </p>
                    </div>

                    {day.events.length === 0 ? (
                      <p className="py-3 text-xs text-muted-foreground/70">No events</p>
                    ) : (
                      <ul className="divide-y divide-border/50">
                        {day.events.map((event) => (
                          <li key={event.id} className="flex items-center gap-4 py-3">
                            <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                              {eventRange(event, timeZone)}
                            </span>
                            <p className="min-w-0 flex-1 truncate text-sm font-medium">
                              {event.title}
                            </p>
                            {event.location ? (
                              <span className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
                                <MapPin aria-hidden className="size-3 shrink-0" />
                                <span className="truncate">{event.location}</span>
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
    </AppShell>
  );
};

export default CalendarPage;
