import type { Metadata } from 'next';

import { Clock3, Focus, UserCog } from 'lucide-react';

import { AppShell } from '@/components/app/app-shell';
import { AutonomyLevelControl } from '@/components/settings/autonomy-level';
import { NotificationToggles } from '@/components/settings/notification-toggles';
import { clockTime, durationLabel } from '@/lib/day-view';
import { getSettings } from '@/server/settings';
import { requireOnboardedUser } from '@/server/session';
import type { Weekday } from '@space/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Settings',
};

const WEEKDAY_LABEL: Record<Weekday, string> = {
  MONDAY: 'Mon',
  TUESDAY: 'Tue',
  WEDNESDAY: 'Wed',
  THURSDAY: 'Thu',
  FRIDAY: 'Fri',
  SATURDAY: 'Sat',
  SUNDAY: 'Sun',
};

const SettingsPage = async () => {
  const { user } = await requireOnboardedUser();
  const settings = await getSettings(user.id);

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl px-4 pt-8 sm:px-6 lg:px-8">
        <header className="border-b border-border/70 pb-6">
          <h1 className="text-3xl font-medium tracking-[-0.035em] text-balance">Settings</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            How Space plans and where it reaches you.
          </p>
        </header>

        <section aria-labelledby="account-heading" className="mt-8">
          <h2
            id="account-heading"
            className="text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase"
          >
            Account
          </h2>
          <div className="mt-3 space-y-3">
            <div className="flex items-center justify-between gap-6 rounded-xl border border-border bg-surface px-5 py-4">
              <span className="text-sm text-muted-foreground">Email</span>
              <span className="text-sm font-medium">{settings.email}</span>
            </div>
            <div className="flex items-center justify-between gap-6 rounded-xl border border-border bg-surface px-5 py-4">
              <span className="text-sm text-muted-foreground">Timezone</span>
              <span className="flex items-center gap-2 text-sm font-medium">
                <UserCog aria-hidden className="size-4 text-muted-foreground" />
                {settings.timeZone}
              </span>
            </div>
          </div>
        </section>

        <section aria-labelledby="autonomy-heading" className="mt-10">
          <h2
            id="autonomy-heading"
            className="text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase"
          >
            Autonomy
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Decide how much Space is allowed to change before it changes anything.
          </p>
          <div className="mt-3">
            <AutonomyLevelControl value={settings.autonomy} />
          </div>
        </section>

        <section aria-labelledby="notifications-heading" className="mt-10">
          <h2
            id="notifications-heading"
            className="text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase"
          >
            Notifications
          </h2>
          <div className="mt-3">
            <NotificationToggles
              inAppNotifications={settings.inAppNotifications}
              emailNotifications={settings.emailNotifications}
            />
          </div>
        </section>

        <section aria-labelledby="planning-heading" className="mt-10">
          <h2
            id="planning-heading"
            className="text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase"
          >
            Planning defaults
          </h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-surface p-4">
              <p className="flex items-center gap-1.5 font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
                <Focus aria-hidden className="size-3.5" />
                Daily focus
              </p>
              <p className="mt-2 text-2xl font-medium tabular-nums">
                {durationLabel(settings.maxDailyFocusMinutes)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Max scheduled per day</p>
            </div>
            <div className="rounded-xl border border-border bg-surface p-4">
              <p className="flex items-center gap-1.5 font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
                <Clock3 aria-hidden className="size-3.5" />
                Breaks
              </p>
              <p className="mt-2 text-2xl font-medium tabular-nums">
                {durationLabel(settings.minBreakMinutes)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Between blocks</p>
            </div>
            <div className="rounded-xl border border-border bg-surface p-4">
              <p className="flex items-center gap-1.5 font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
                <Clock3 aria-hidden className="size-3.5" />
                Buffer
              </p>
              <p className="mt-2 text-2xl font-medium tabular-nums">
                {durationLabel(settings.bufferMinutes)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Padding around work</p>
            </div>
          </div>

          <div className="mt-3 rounded-xl border border-border bg-surface px-5 py-4">
            <p className="text-sm font-medium">Working hours</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Set during onboarding; the planner only schedules inside these windows.
            </p>
            <ul className="mt-3 flex flex-wrap gap-2">
              {settings.workingHours.length === 0 ? (
                <li className="text-xs text-muted-foreground/70">None defined</li>
              ) : (
                settings.workingHours.map((block) => (
                  <li
                    key={block.weekday}
                    className="rounded-md bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground tabular-nums"
                  >
                    {WEEKDAY_LABEL[block.weekday]} {clockTime(block.startMinute)}–
                    {clockTime(block.endMinute)}
                  </li>
                ))
              )}
            </ul>
          </div>
        </section>
      </div>
    </AppShell>
  );
};

export default SettingsPage;
