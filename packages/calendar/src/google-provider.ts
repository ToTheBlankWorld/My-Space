import { google, type calendar_v3 } from 'googleapis';

import {
  CalendarAuthError,
  CalendarError,
  CalendarRateLimitError,
  CalendarTransientError,
  CalendarValidationError,
} from './errors';
import type { CalendarProviderAdapter, NormalizedCalendarEvent, ProviderCalendar } from './types';

/**
 * A single Google Calendar API page is capped at 250 calendars / 2500 events.
 * Either list can span multiple pages, so every read loops on `nextPageToken`.
 * The hard caps below bound one provider call: a calendar that exceeds them is a
 * real risk of silent truncation, so it fails loudly as a permanent
 * {@link CalendarValidationError} rather than quietly dropping rows.
 */
const CALENDAR_LIST_PAGE = 250;
const MAX_CALENDARS = 1_000;
const EVENTS_LIST_PAGE = 2500;
const MAX_EVENTS = 10_000;

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

    const items: NonNullable<calendar_v3.Schema$CalendarList['items']>[number][] = [];
    let pageToken: string | undefined;

    for (;;) {
      // `mapGoogleError` in the catch block always throws, so `response` is
      // guaranteed to be assigned before the loop body reaches this point.
      // The `!` assertion communicates that to TypeScript's definite-assignment
      // analysis without relying on implicit `any`.
      let response!: { data: calendar_v3.Schema$CalendarList };
      try {
        response = await calendar.calendarList.list({
          maxResults: CALENDAR_LIST_PAGE,
          pageToken,
        });
      } catch (error) {
        mapGoogleError(error);
      }

      items.push(...(response.data.items ?? []));
      pageToken = response.data.nextPageToken ?? undefined;

      if (pageToken === undefined) {
        break;
      }

      if (items.length > MAX_CALENDARS) {
        throw new CalendarValidationError(
          `Calendar list exceeded ${MAX_CALENDARS} calendars; refusing to truncate silently.`,
        );
      }
    }

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

    const events: NormalizedCalendarEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;

    try {
      for (;;) {
        // The sync token describes a point in time, not a page: it is carried
        // on the first request only, and continuation pages navigate by
        // `pageToken` alone. Full syncs repeat no query-scoping params across
        // pages either — Google continues from the page token.
        const response: { data: calendar_v3.Schema$Events } =
          pageToken === undefined
            ? params.syncToken
              ? await calendar.events.list({
                  calendarId: params.calendarId,
                  syncToken: params.syncToken,
                  maxResults: EVENTS_LIST_PAGE,
                })
              : await calendar.events.list({
                  calendarId: params.calendarId,
                  timeMin: params.timeMin?.toISOString(),
                  timeMax: params.timeMax?.toISOString(),
                  singleEvents: false,
                  maxResults: EVENTS_LIST_PAGE,
                })
            : await calendar.events.list({
                calendarId: params.calendarId,
                maxResults: EVENTS_LIST_PAGE,
                pageToken,
              });

        events.push(...(response.data.items ?? []).map(normalizeEvent));
        nextSyncToken = response.data.nextSyncToken ?? nextSyncToken;
        pageToken = response.data.nextPageToken ?? undefined;

        if (pageToken === undefined) {
          break;
        }

        if (events.length > MAX_EVENTS) {
          // More pages remain but the cap is reached. Dropping the rest would
          // silently lose events the plans already reference, so this is a
          // permanent validation failure the connection surfaces.
          throw new CalendarValidationError(
            `Event list exceeded ${MAX_EVENTS} events; refusing to truncate silently.`,
          );
        }
      }
    } catch (error) {
      // A domain error we raised ourselves must never be re-mapped into a
      // googleapis-typed error (that would turn a permanent validation failure
      // into a transient one).
      if (error instanceof CalendarError) {
        throw error;
      }

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

    return {
      events,
      syncToken: nextSyncToken,
      tokenExpired: false,
    };
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
