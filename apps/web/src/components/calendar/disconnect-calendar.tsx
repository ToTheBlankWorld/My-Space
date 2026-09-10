'use client';

import { Unplug } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

interface DisconnectCalendarProps {
  connectionId: string;
}

/**
 * Disconnects one calendar connection through the existing route handler.
 *
 * The route revokes the token best-effort, marks the connection DISCONNECTED
 * and deselects its calendars; mirrored events are kept so existing plans still
 * resolve. The list is then re-read from the server.
 */
export const DisconnectCalendar = ({ connectionId }: DisconnectCalendarProps) => {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const disconnect = () => {
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch('/api/calendar/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connectionId }),
        });
        if (!response.ok) {
          setError('That connection could not be removed.');
          return;
        }
        router.refresh();
      } catch {
        setError('That connection could not be removed.');
      }
    });
  };

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={disconnect}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-wait"
      >
        <Unplug aria-hidden className="size-3.5" />
        Disconnect
      </button>
      {error ? (
        <p role="status" className="text-sm text-muted-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
};
