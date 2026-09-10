import type { Metadata } from 'next';
import Link from 'next/link';

import { AuthHeader } from '@/components/auth/auth-header';
import { site } from '@/lib/site';
import { getNotificationsService } from '@/server/notifications';
import { requireOnboardedUser } from '@/server/session';

import { markAllNotificationsRead } from './mark-all-read';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Notifications',
};

const formatTime = (value: Date): string =>
  new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value);

const NotificationPage = async () => {
  const { user } = await requireOnboardedUser();

  const service = getNotificationsService();
  const [unread, page] = await Promise.all([service.unreadCount(user.id), service.list(user.id)]);

  return (
    <>
      <AuthHeader />
      <main id="main" className="mx-auto w-full max-w-6xl px-6 pt-16 pb-24">
        <div className="flex items-end justify-between gap-6">
          <div>
            <p className="font-mono text-xs tracking-[0.14em] text-muted-foreground uppercase">
              Stage 07 — Notifications
            </p>
            <h1 className="mt-4 text-3xl font-medium tracking-[-0.03em] text-balance">
              Notifications
            </h1>
          </div>
          <p className="text-sm text-muted-foreground tabular-nums">
            {unread > 0 ? `${unread} unread` : 'All caught up'}
          </p>
        </div>

        {page.items.length === 0 ? (
          <div className="mt-10 rounded-xl border border-border bg-surface px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Nothing here yet. Reminder, plan-change and daily-brief notifications land in this
              inbox as the background sweeps run.
            </p>
          </div>
        ) : (
          <>
            <ul className="mt-10 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border">
              {page.items.map((notification) => (
                <li key={notification.id} className="bg-surface px-6 py-5">
                  <div className="flex items-start justify-between gap-6">
                    <div className="min-w-0">
                      {notification.linkUrl !== null ? (
                        <Link
                          href={notification.linkUrl}
                          className="text-sm font-medium break-words hover:underline"
                        >
                          {notification.title}
                        </Link>
                      ) : (
                        <h2 className="text-sm font-medium break-words">{notification.title}</h2>
                      )}
                      <p className="mt-1 text-sm leading-relaxed break-words text-muted-foreground">
                        {notification.body}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatTime(notification.createdAt)}
                      </span>
                      <span
                        className={
                          notification.readAt === null
                            ? 'rounded-full bg-accent px-2 py-0.5 font-mono text-[0.6875rem] tracking-[0.12em] text-background uppercase'
                            : 'rounded-full border border-border px-2 py-0.5 font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase'
                        }
                      >
                        {notification.readAt === null ? 'Unread' : 'Read'}
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            {unread > 0 && (
              <form action={markAllNotificationsRead} className="mt-8">
                <button
                  type="submit"
                  className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
                >
                  Mark all as read
                </button>
              </form>
            )}
          </>
        )}

        <p className="mt-12 text-sm text-muted-foreground tabular-nums">
          &copy; {site.copyrightYear} {site.name}
        </p>
      </main>
    </>
  );
};

export default NotificationPage;
