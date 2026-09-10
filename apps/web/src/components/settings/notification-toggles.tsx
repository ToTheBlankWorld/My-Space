'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Switch } from '@space/ui';

import { setEmailNotifications, setInAppNotifications } from '@/actions/preferences';
import type { PreferenceActionResult } from '@/actions/preferences';

interface NotificationTogglesProps {
  inAppNotifications: boolean;
  emailNotifications: boolean;
}

/**
 * Notification delivery toggles.
 *
 * Each switch owns exactly one column in `user_preferences`, written through
 * its server action, so flipping one never resets the other or the planning
 * settings. The row re-reads the profile after a successful write.
 */
export const NotificationToggles = ({
  inAppNotifications,
  emailNotifications,
}: NotificationTogglesProps) => {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (action: (form: FormData) => Promise<PreferenceActionResult>, enabled: boolean) => {
    setError(null);
    const form = new FormData();
    form.set('enabled', enabled ? 'on' : 'off');
    startTransition(async () => {
      const result = await action(form);
      if (!result.ok) {
        setError(result.error ?? 'That setting could not be saved.');
        return;
      }
      router.refresh();
    });
  };

  return (
    <div>
      <ul className="divide-y divide-border/50 rounded-xl border border-border bg-surface">
        <li className="flex items-center justify-between gap-6 px-5 py-4">
          <div>
            <p className="text-sm font-medium">In-app notifications</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Plan changes and reminders in the app inbox.
            </p>
          </div>
          <Switch
            checked={inAppNotifications}
            onCheckedChange={(next) => run(setInAppNotifications, next)}
            disabled={pending}
            label="In-app notifications"
          />
        </li>
        <li className="flex items-center justify-between gap-6 px-5 py-4">
          <div>
            <p className="text-sm font-medium">Email notifications</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Daily briefs and deadline warnings by email.
            </p>
          </div>
          <Switch
            checked={emailNotifications}
            onCheckedChange={(next) => run(setEmailNotifications, next)}
            disabled={pending}
            label="Email notifications"
          />
        </li>
      </ul>
      {error ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
};
