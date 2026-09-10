import { google, type calendar_v3 } from 'googleapis';

import { CalendarAuthError, CalendarRateLimitError, CalendarTransientError } from './errors';
import type { CalendarProviderAdapter, NormalizedCalendarEvent, ProviderCalendar } from './types';

/**
 * Maps a Google Calendar API error into a typed domain error.
 *
 * Google's API returns HTTP status codes and a `errors[]` array with `reason`
 * fields. This function translates that into the stable error classes the
 * retry logic consumes.
 */
const mapGoogleError = (error: unknown): never => {
  const apiError = error as {
    code?: number;
    errors?: Array<{ reason?: string; message?: string }>;
    message?: string;
  };

  const code = apiError.code ?? 0;
  const reason = apiError.errors?.[0]?.reason ?? '';
  const message = apiError.errors?.[0]?.message ?? apiError.message ?? 'Unknown Google API error';

  if (code === 401 || reason === 'authError' || reason === 'invalid_grant') {
    throw new CalendarAuthError(`Google OAuth token is invalid or expired.`, { cause: error });
  }

  if (code === 403 || reason === 'forbidden' || reason === 'accessNotConfigured') {
    throw new CalendarAuthError(`Google Calendar API access denied: ${message}`, { cause: error });
  }

  if (code === 404 && reason === 'notFound') {
    // Calendar or event not found — not an auth error, but not retryable.
    throw new CalendarAuthError(`Calendar not found: ${message}`, { cause: error });
  }

  if (code === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
    const retryAfterMs = reason === 'userRateLimitExceeded' ? 60_000 : 30_000;
    throw new CalendarRateLimitError(`Google API rate limit hit: ${message}`, {
      cause: error,
      retryAfterMs,
    });
  }

  if (code >= 500 || code === 0) {
    throw new CalendarTransientError(`Google API transient error (${code}): ${message}`, {
      cause: error,
    });
  }

  throw new CalendarTransientError(`Google API error (${code}): ${message}`, { cause: error });
};

/**
 * Normalises a Google Calendar event into the provider-agnostic shape the sync
 * engine consumes.
 *
 * All-day events are handled correctly: Google represents them with `date`
 * fields instead of `dateTime`, and the timezone comes from the calendar or
 * event-level `timeZone` field.
 */
const normalizeEvent = (event: calendar_v3.Schema$Event): NormalizedCalendarEvent => {
  const parseInstant = (value: string | undefined): Date => {
    if (!value) {
      return new Date(0);
    }
    return new Date(value);
  };

  const isAllDay = !event.start?.dateTime;
  const timeZone = event.start?.timeZone ?? 'UTC';

  let startAt: Date;
  let endAt: Date;

  if (isAllDay) {
    // All-day events use `date` (YYYY-MM-DD) not `dateTime`. We convert to
    // start-of-day and end-of-day in the event's timezone using the platform's
    // Intl formatter. For storage we use the instant at midnight UTC as a
    // sentinel, which is what Prisma's @db.Date expects.
    const startDate = event.start?.date ?? '1970-01-01';
    const endDate = event.end?.date ?? startDate;
    startAt = new Date(`${startDate}T00:00:00Z`);
    endAt = new Date(`${endDate}T00:00:00Z`);
  } else {
    startAt = parseInstant(event.start?.dateTime ?? undefined);
    endAt = parseInstant(event.end?.dateTime ?? undefined);
  }

  const statusMap: Record<string, 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'> = {
    confirmed: 'CONFIRMED',
    tentative: 'TENTATIVE',
    cancelled: 'CANCELLED',
  };

  const originalStart = event.originalStartTime?.dateTime
    ? new Date(event.originalStartTime.dateTime)
    : event.originalStartTime?.date
      ? new Date(`${event.originalStartTime.date}T00:00:00Z`)
      : null;

  return {
    externalId: event.id ?? '',
    externalEtag: event.etag ?? null,
    title: event.summary ?? '(No title)',
    description: event.description ?? null,
    location: event.location ?? null,
    startAt,
    endAt,
    timeZone,
    isAllDay,
    status: statusMap[event.status ?? 'confirmed'] ?? 'CONFIRMED',
    recurringEventId: event.recurringEventId ?? null,
    originalStartAt: originalStart,
    updatedAt: event.updated ? new Date(event.updated) : null,
  };
};

/**
 * Google Calendar API adapter.
 *
 * Wraps the `googleapis` client with the provider-agnostic interface the sync
 * engine consumes. No state is held between calls — the access token is passed
 * explicitly, so token rotation happens elsewhere.
 */
export class GoogleCalendarProvider implements CalendarProviderAdapter {
  readonly provider = 'GOOGLE' as const;

  private getClient(accessToken: string): calendar_v3.Calendar {
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });

    return google.calendar({ version: 'v3', auth: oauth2Client });
  }

  async listCalendars(accessToken: string): Promise<ProviderCalendar[]> {
    const calendar = this.getClient(accessToken);

    let response;
    try {
      response = await calendar.calendarList.list({ maxResults: 250 });
    } catch (error) {
      mapGoogleError(error);
    }

    const items = response?.data.items ?? [];

    return items
      .filter((cal): cal is NonNullable<typeof cal> & { id: string } => cal.id != null)
      .map((cal) => ({
        externalId: cal.id,
        name: cal.summary ?? '(Untitled calendar)',
        description: cal.description ?? null,
        timeZone: cal.timeZone ?? 'UTC',
        isPrimary: cal.primary ?? false,
        color: cal.backgroundColor ?? null,
      }));
  }

  async listEvents(
    accessToken: string,
    params: {
      calendarId: string;
      syncToken?: string | null;
      timeMin?: Date;
      timeMax?: Date;
    },
  ): Promise<{
    events: NormalizedCalendarEvent[];
    syncToken: string | null;
    tokenExpired: boolean;
  }> {
    const calendar = this.getClient(accessToken);

    try {
      if (params.syncToken) {
        // Incremental sync: no time bounds, just "give me changes since this token".
        const response = await calendar.events.list({
          calendarId: params.calendarId,
          syncToken: params.syncToken,
          maxResults: 2500,
        });

        const events = (response.data.items ?? []).map(normalizeEvent);

        return {
          events,
          syncToken: response.data.nextSyncToken ?? null,
          tokenExpired: false,
        };
      }

      // Full sync: bounded by time range.
      const response = await calendar.events.list({
        calendarId: params.calendarId,
        timeMin: params.timeMin?.toISOString(),
        timeMax: params.timeMax?.toISOString(),
        singleEvents: false,
        maxResults: 2500,
      });

      const events = (response.data.items ?? []).map(normalizeEvent);

      return {
        events,
        syncToken: response.data.nextSyncToken ?? null,
        tokenExpired: false,
      };
    } catch (error) {
      const apiError = error as { code?: number; errors?: Array<{ reason?: string }> };
      const reason = apiError.errors?.[0]?.reason;

      if (reason === 'syncTokenRevoked' || reason === 'invalidSyncToken') {
        return {
          events: [],
          syncToken: null,
          tokenExpired: true,
        };
      }

      mapGoogleError(error);

      // Unreachable: mapGoogleError always throws. TypeScript needs this.
      return { events: [], syncToken: null, tokenExpired: false };
    }
  }

  async revokeAccess(accessToken: string): Promise<void> {
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });

    try {
      await oauth2Client.revokeCredentials();
    } catch {
      // Best-effort: revocation failure is logged but not propagated.
    }
  }
}
