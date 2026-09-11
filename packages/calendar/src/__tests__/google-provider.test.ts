import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Google-provider pagination tests.
 *
 * `googleapis` is mocked at the module boundary: the real client is a thin
 * wrapper over HTTP, so the unit under test is the pagination logic that turns
 * multi-page Google responses into one bounded, uncorrupted list.
 */

const mocks = vi.hoisted(() => {
  const eventsList = vi.fn();
  const calendarList = vi.fn();
  return {
    eventsList,
    calendarList,
    client: {
      events: { list: eventsList },
      calendarList: { list: calendarList },
    },
  };
});

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials(): void {}
      },
    },
    calendar: () => mocks.client,
  },
}));

import { CalendarValidationError } from '../errors';
import { GoogleCalendarProvider } from '../google-provider';

const EMPTY_PAGE = { data: { items: [] } };

/** A page of `n` minimal events, optionally with a `nextPageToken`. */
const eventsPage = (
  count: number,
  {
    start = 0,
    nextPageToken,
    nextSyncToken,
  }: { start?: number; nextPageToken?: string; nextSyncToken?: string } = {},
) => ({
  data: {
    items: Array.from({ length: count }, (_, index) => ({ id: `evt-${start + index}` })),
    ...(nextPageToken !== undefined ? { nextPageToken } : {}),
    ...(nextSyncToken !== undefined ? { nextSyncToken } : {}),
  },
});

/** A page of `n` minimal calendars, optionally with a `nextPageToken`. */
const calendarsPage = (
  count: number,
  { start = 0, nextPageToken }: { start?: number; nextPageToken?: string } = {},
) => ({
  data: {
    items: Array.from({ length: count }, (_, index) => ({ id: `cal-${start + index}` })),
    ...(nextPageToken !== undefined ? { nextPageToken } : {}),
  },
});

describe('GoogleCalendarProvider pagination', () => {
  const provider = new GoogleCalendarProvider();

  afterEach(() => {
    mocks.eventsList.mockReset();
    mocks.calendarList.mockReset();
  });

  it('follows nextPageToken until the events list is exhausted', async () => {
    mocks.eventsList
      .mockResolvedValueOnce(eventsPage(2, { nextPageToken: 'page-2' }))
      .mockResolvedValueOnce(eventsPage(3, { start: 2, nextSyncToken: 'sync-2' }));

    const result = await provider.listEvents('token', { calendarId: 'cal1', timeMin: new Date(0) });

    expect(result.events.map((event) => event.externalId)).toEqual([
      'evt-0',
      'evt-1',
      'evt-2',
      'evt-3',
      'evt-4',
    ]);
    expect(result.syncToken).toBe('sync-2');
    expect(result.tokenExpired).toBe(false);
    expect(mocks.eventsList).toHaveBeenCalledTimes(2);
    expect(mocks.eventsList.mock.calls[1]?.[0]).toMatchObject({ pageToken: 'page-2' });
  });

  it('follows nextPageToken for incremental syncs too', async () => {
    mocks.eventsList
      .mockResolvedValueOnce(eventsPage(1, { nextPageToken: 'page-2' }))
      .mockResolvedValueOnce(eventsPage(1, { start: 1 }));

    const result = await provider.listEvents('token', {
      calendarId: 'cal1',
      syncToken: 'stale-but-valid',
    });

    expect(result.events).toHaveLength(2);
    // The sync token is carried on the first request only; continuation pages
    // navigate by pageToken alone. The continuation page carries exactly these
    // three props (no syncToken, no time bounds).
    expect(mocks.eventsList).toHaveBeenNthCalledWith(1, {
      calendarId: 'cal1',
      syncToken: 'stale-but-valid',
      maxResults: 2500,
    });
    expect(mocks.eventsList).toHaveBeenNthCalledWith(2, {
      calendarId: 'cal1',
      maxResults: 2500,
      pageToken: 'page-2',
    });
  });

  it('fails loudly when the event cap is exceeded with pages still pending', async () => {
    mocks.eventsList.mockResolvedValueOnce(eventsPage(10_001, { nextPageToken: 'more' }));

    // The permanent error must survive unmapped — a transient classification
    // would retry a failure retrying cannot fix. Asserted in one call so the
    // single mocked page is consumed exactly once.
    expect.assertions(2);
    await provider
      .listEvents('token', { calendarId: 'cal1', timeMin: new Date(0) })
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(CalendarValidationError);
        expect((error as Error).message).toMatch('Event list exceeded');
      });
  });

  it('surfaces a stale incremental sync token as tokenExpired', async () => {
    mocks.eventsList.mockRejectedValueOnce({ errors: [{ reason: 'syncTokenRevoked' }] });

    const result = await provider.listEvents('token', {
      calendarId: 'cal1',
      syncToken: 'revoked',
    });

    expect(result).toEqual({ events: [], syncToken: null, tokenExpired: true });
  });

  it('follows nextPageToken until the calendar list is exhausted', async () => {
    mocks.calendarList
      .mockResolvedValueOnce(calendarsPage(2, { nextPageToken: 'page-2' }))
      .mockResolvedValueOnce(calendarsPage(1, { start: 2 }));

    const calendars = await provider.listCalendars('token');

    expect(calendars.map((calendar) => calendar.externalId)).toEqual(['cal-0', 'cal-1', 'cal-2']);
    expect(mocks.calendarList).toHaveBeenCalledTimes(2);
  });

  it('fails loudly when the calendar cap is exceeded with pages still pending', async () => {
    mocks.calendarList.mockResolvedValueOnce(calendarsPage(1_001, { nextPageToken: 'more' }));

    await expect(provider.listCalendars('token')).rejects.toBeInstanceOf(CalendarValidationError);
  });

  it('does not follow a token that the provider never issues', async () => {
    mocks.eventsList.mockResolvedValueOnce(EMPTY_PAGE);

    const result = await provider.listEvents('token', { calendarId: 'cal1', timeMin: new Date(0) });

    expect(result.events).toHaveLength(0);
    expect(mocks.eventsList).toHaveBeenCalledTimes(1);
  });
});
