import type { ReactNode } from 'react';

import Link from 'next/link';

import { site } from '@/lib/site';
import { getNotificationsService } from '@/server/notifications';
import { getPlanningService } from '@/server/planning';
import { requireOnboardedUser } from '@/server/session';

import { SignOutButton } from '../auth/sign-out-button';
import { AppNav } from './app-nav';

/**
 * The product shell every authenticated screen shares.
 *
 * Owns the session check, the Today anchor (the user's current day in *their*
 * timezone, not the server's), the unread badge, and the primary navigation. It
 * keeps the skip target `#main` so the root layout's skip link still lands on
 * the actual content.
 */
interface AppShellProps {
  children: ReactNode;
}

export const AppShell = async ({ children }: AppShellProps) => {
  const { user } = await requireOnboardedUser();
  const today = await getPlanningService().getToday(user.id);
  const unread = await getNotificationsService().unreadCount(user.id);

  const firstName = user.name?.trim().split(' ')[0] ?? user.email;

  return (
    <div className="min-h-dvh bg-background">
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-border bg-surface md:flex">
          <div className="flex h-16 items-center gap-2.5 border-b border-border/80 px-5">
            <Link
              href="/dashboard"
              className="flex items-center gap-2.5 rounded-sm text-[0.9375rem] font-medium tracking-[-0.01em]"
            >
              <span aria-hidden className="size-2 rounded-full bg-accent" />
              {site.name}
            </Link>
          </div>

          <AppNav todayHref={`/space/${today.date}`} unread={unread} className="px-3 py-4" />

          <div className="mt-auto border-t border-border/80 px-5 py-4">
            <p className="truncate text-[0.8125rem] font-medium text-foreground">{firstName}</p>
            <div className="mt-3">
              <SignOutButton />
            </div>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border/80 bg-background/80 px-4 backdrop-blur md:hidden">
            <Link
              href="/dashboard"
              aria-label={`${site.name} overview`}
              className="flex shrink-0 items-center gap-2 text-sm font-medium tracking-[-0.01em]"
            >
              <span aria-hidden className="size-2 rounded-full bg-accent" />
            </Link>
            <div className="min-w-0 flex-1">
              <AppNav
                todayHref={`/space/${today.date}`}
                unread={unread}
                compact
                className="flex-row justify-between gap-1"
              />
            </div>
          </header>

          <main id="main" className="pb-24">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
};
