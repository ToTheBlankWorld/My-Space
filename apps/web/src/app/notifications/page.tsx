import type { Metadata } from 'next';
import Link from 'next/link';

import {
  AlarmClock,
  ArrowRightLeft,
  BellRing,
  BellOff,
  ClipboardList,
  Info,
  MailOpen,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { EmptyState, StatusDot } from '@space/ui';
import type { Notification as NotificationRow } from '@space/database';
import type { CalendarDate } from '@space/types';
import { addCalendarDays, toCalendarDate } from '@space/time';

import { AppShell } from '@/components/app/app-shell';
import { markAllNotificationsRead, markNotificationRead } from '@/actions/notifications';
import { longDate, timeOf } from '@/lib/day-view';
import { getNotificationsService } from '@/server/notifications';
import { getPlanningService } from '@/server/planning';
import { requireOnboardedUser } from '@/server/session';
import { clock } from '@/server/clock';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Notifications',
};

type RowType = NotificationRow['type'];
type RowPriority = NotificationRow['priority'];

const TYPE_META: Partial<Record<RowType, { label: string; icon: LucideIcon }>> = {
  DAILY_PLAN: { label: 'Daily plan', icon: ClipboardList },
  TASK_REMINDER: { label: 'Task reminder', icon: BellRing },
  DEADLINE_WARNING: { label: 'Deadline warning', icon: AlarmClock },
  SCHEDULE_CHANGE: { label: 'Schedule change', icon: ArrowRightLeft },
  SYSTEM: { label: 'System', icon: Info },
};

const priorityTone: Record<RowPriority, 'danger' | 'warning' | 'accent' | 'neutral'> = {
  CRITICAL: 'danger',
  IMPORTANT: 'warning',
  NORMAL: 'accent',
  SILENT: 'neutral',
};

const groupLabel = (date: CalendarDate, today: CalendarDate): string => {
  if (date === today) return 'Today';
  if (addCalendarDays(date, 1) === today) return 'Yesterday';
  return longDate(date);
};

const groupNotifications = (rows: readonly NotificationRow[], timeZone: string) => {
  const groups = new Map<CalendarDate, NotificationRow[]>();
  for (const row of rows) {
    const date = toCalendarDate(row.createdAt, timeZone);
    groups.set(date, [...(groups.get(date) ?? []), row]);
  }
  return [...groups.entries()];
};

const NotificationsPage = async () => {
  const { user } = await requireOnboardedUser();
  const { timeZone } = await getPlanningService().getToday(user.id);
  const service = getNotificationsService();

  const [unread, page] = await Promise.all([
    service.unreadCount(user.id),
    service.list(user.id, { page: { limit: 100 } }),
  ]);

  const today = toCalendarDate(clock.now(), timeZone);

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl px-4 pt-8 sm:px-6 lg:px-8">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border/70 pb-6">
          <div>
            <h1 className="text-3xl font-medium tracking-[-0.035em] text-balance">Notifications</h1>
            <p className="mt-2 text-sm text-muted-foreground tabular-nums">
              {unread > 0 ? `${unread} unread` : 'Everything is read'}
            </p>
          </div>
          {unread > 0 ? (
            <form action={markAllNotificationsRead}>
              <button
                type="submit"
                className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
              >
                <MailOpen aria-hidden className="size-4" />
                Mark all as read
              </button>
            </form>
          ) : null}
        </header>

        {page.items.length === 0 ? (
          <EmptyState
            className="mt-8 rounded-xl border border-border"
            icon={<BellOff aria-hidden className="size-5" />}
            title="All quiet"
            description="Daily plans, schedule changes and deadline warnings appear here as they happen."
          />
        ) : (
          <ol className="mt-8 space-y-8">
            {groupNotifications(page.items, timeZone).map(([date, rows]) => (
              <li key={date}>
                <p className="border-b border-border/50 pb-2 font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
                  {groupLabel(date, today)}
                </p>
                <ul className="divide-y divide-border/50">
                  {rows.map((notification) => {
                    const meta = TYPE_META[notification.type] ?? {
                      label: notification.type.toLowerCase(),
                      icon: Info,
                    };
                    const Icon = meta.icon;
                    const isUnread = notification.readAt === null;

                    return (
                      <li key={notification.id} className="flex items-start gap-4 py-4">
                        <span
                          className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${
                            isUnread ? 'bg-accent/15 text-accent' : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          <Icon aria-hidden className="size-4" />
                        </span>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            {notification.linkUrl ? (
                              <Link
                                href={notification.linkUrl}
                                className="text-sm font-medium text-foreground hover:underline"
                              >
                                {notification.title}
                              </Link>
                            ) : (
                              <p className="text-sm font-medium text-foreground">
                                {notification.title}
                              </p>
                            )}
                            {isUnread ? (
                              <span
                                aria-hidden
                                className="size-1.5 shrink-0 rounded-full bg-accent"
                              />
                            ) : null}
                          </div>
                          {notification.body ? (
                            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                              {notification.body}
                            </p>
                          ) : null}
                          <p className="mt-2 flex items-center gap-2 font-mono text-[0.6875rem] text-muted-foreground/70 tabular-nums">
                            <StatusDot
                              tone={priorityTone[notification.priority]}
                              label={notification.priority.toLowerCase()}
                            />
                            {meta.label} · {timeOf(notification.createdAt, timeZone)}
                          </p>
                        </div>

                        <div className="flex shrink-0 flex-col items-end gap-2">
                          {isUnread ? (
                            <form action={markNotificationRead}>
                              <input type="hidden" name="id" value={notification.id} />
                              <button
                                type="submit"
                                className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                              >
                                Mark read
                              </button>
                            </form>
                          ) : (
                            <span className="font-mono text-[0.6875rem] text-muted-foreground/60 uppercase">
                              Read
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </div>
    </AppShell>
  );
};

export default NotificationsPage;
