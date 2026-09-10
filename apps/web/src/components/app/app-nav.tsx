'use client';

import { Bell, CalendarDays, LayoutGrid, Settings as SettingsIcon, Sun } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@space/ui';

interface AppNavProps {
  todayHref: string;
  unread: number;
  /** Hide link labels for a dense horizontal bar. */
  compact?: boolean;
  className?: string;
}

interface NavItem {
  label: string;
  href: string;
  icon: typeof Sun;
  matchPrefix: string;
}

const ITEMS: NavItem[] = [
  { label: 'Overview', href: '/dashboard', icon: LayoutGrid, matchPrefix: '/dashboard' },
  { label: 'Today', href: '/space', icon: Sun, matchPrefix: '/space' },
  { label: 'Notifications', href: '/notifications', icon: Bell, matchPrefix: '/notifications' },
  { label: 'Calendar', href: '/calendar', icon: CalendarDays, matchPrefix: '/calendar' },
  { label: 'Settings', href: '/settings', icon: SettingsIcon, matchPrefix: '/settings' },
];

/**
 * Primary product navigation.
 *
 * The Today entry resolves each request to the user's actual current day
 * (computed server-side in the shell), so the rail never guesses a "today" from
 * the viewer's clock.
 */
export const AppNav = ({ todayHref, unread, compact = false, className }: AppNavProps) => {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className={cn('flex flex-col gap-1', className)}>
      {ITEMS.map((item) => {
        const isActive =
          item.matchPrefix === '/space'
            ? pathname.startsWith('/space')
            : pathname.startsWith(item.matchPrefix);

        const href = item.matchPrefix === '/space' ? todayHref : item.href;
        const Icon = item.icon;

        return (
          <Link
            key={item.label}
            href={href}
            aria-current={isActive ? 'page' : undefined}
            aria-label={compact && !isActive ? item.label : undefined}
            className={cn(
              'flex h-9 shrink-0 items-center gap-2.5 rounded-md px-3 text-sm transition-colors duration-200',
              isActive
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
            )}
          >
            <Icon aria-hidden className="size-4 shrink-0" />
            {!compact ? <span className="truncate">{item.label}</span> : null}
            {item.matchPrefix === '/notifications' && unread > 0 ? (
              <span
                aria-label={`${unread} unread`}
                className="ml-auto rounded-full bg-accent/15 px-1.5 py-0.5 font-mono text-[0.6875rem] font-medium text-foreground tabular-nums"
              >
                {unread > 99 ? '99+' : unread}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
};
