'use client';

import { CalendarPlus, Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';

/**
 * Starts the Google Calendar OAuth flow through the existing route handler.
 *
 * The route sets the anti-CSRF `state` cookie and returns the consent URL; the
 * browser leaves for Google and comes back to `/api/calendar/callback`, which
 * stores the connection. Nothing secret lives in this component.
 */
export const ConnectCalendar = () => {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const connect = () => {
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch('/api/calendar/connection', { method: 'POST' });
        if (!response.ok) {
          setError('Calendar connection could not be started.');
          return;
        }
        const body = (await response.json()) as { url?: string };
        if (!body.url) {
          setError('Calendar connection could not be started.');
          return;
        }
        window.location.assign(body.url);
      } catch {
        setError('Calendar connection could not be started.');
      }
    });
  };

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={connect}
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-wait"
      >
        {pending ? (
          <Loader2 aria-hidden className="size-4 animate-spin" />
        ) : (
          <CalendarPlus aria-hidden className="size-4" />
        )}
        Connect Google Calendar
      </button>
      {error ? (
        <p role="status" className="text-sm text-muted-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
};
