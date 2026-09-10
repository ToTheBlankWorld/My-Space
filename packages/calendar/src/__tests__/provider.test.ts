import { describe, expect, it } from 'vitest';

import type { CalendarProviderAdapter, NormalizedCalendarEvent, SyncResult } from '../types';

/**
 * Fake calendar provider for testing.
 *
 * Returns deterministic results without hitting any external API.
 * Used by sync service tests to verify logic without Google dependencies.
 */
class FakeCalendarProvider implements CalendarProviderAdapter {
  readonly provider = 'GOOGLE' as const;

  private calendars: Array<{ id: string; name: string; timeZone: string }> = [];
  private events: NormalizedCalendarEvent[] = [];
  private syncToken: string | null = null;
  private tokenExpired = false;
  private revoked = false;

  setCalendars(calendars: Array<{ id: string; name: string; timeZone: string }>): void {
    this.calendars = calendars;
  }

  setEvents(events: NormalizedCalendarEvent[]): void {
    this.events = events;
  }

  setSyncToken(token: string | null): void {
    this.syncToken = token;
  }

  setTokenExpired(expired: boolean): void {
    this.tokenExpired = expired;
  }

  wasRevoked(): boolean {
    return this.revoked;
  }

  listCalendars(_accessToken: string) {
    return Promise.resolve(
      this.calendars.map((cal) => ({
        externalId: cal.id,
        name: cal.name,
        description: null,
        timeZone: cal.timeZone,
        isPrimary: true,
        color: null,
      })),
    );
  }

  listEvents(
    _accessToken: string,
    _params: { calendarId: string; syncToken?: string | null; timeMin?: Date; timeMax?: Date },
  ) {
    return Promise.resolve({
      events: this.events,
      syncToken: this.syncToken,
      tokenExpired: this.tokenExpired,
    });
  }

  revokeAccess(_accessToken: string): Promise<void> {
    this.revoked = true;
    return Promise.resolve();
  }
}

describe('FakeCalendarProvider', () => {
  it('returns configured calendars', async () => {
    const provider = new FakeCalendarProvider();
    provider.setCalendars([
      { id: 'cal1', name: 'Primary', timeZone: 'America/New_York' },
      { id: 'cal2', name: 'Work', timeZone: 'Europe/London' },
    ]);

    const calendars = await provider.listCalendars('token');
    expect(calendars).toHaveLength(2);
    expect(calendars[0]?.externalId).toBe('cal1');
    expect(calendars[0]?.name).toBe('Primary');
    expect(calendars[1]?.externalId).toBe('cal2');
  });

  it('returns configured events', async () => {
    const provider = new FakeCalendarProvider();
    provider.setEvents([
      {
        externalId: 'evt1',
        title: 'Meeting',
        startAt: new Date('2026-03-30T09:00:00Z'),
        endAt: new Date('2026-03-30T10:00:00Z'),
        timeZone: 'UTC',
        isAllDay: false,
        status: 'CONFIRMED',
      },
    ]);

    const result = await provider.listEvents('token', { calendarId: 'cal1' });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.title).toBe('Meeting');
  });

  it('returns sync token', async () => {
    const provider = new FakeCalendarProvider();
    provider.setSyncToken('next-token-123');

    const result = await provider.listEvents('token', { calendarId: 'cal1' });
    expect(result.syncToken).toBe('next-token-123');
  });

  it('returns token expired flag', async () => {
    const provider = new FakeCalendarProvider();
    provider.setTokenExpired(true);

    const result = await provider.listEvents('token', { calendarId: 'cal1' });
    expect(result.tokenExpired).toBe(true);
    expect(result.events).toHaveLength(0);
  });

  it('tracks revocation', async () => {
    const provider = new FakeCalendarProvider();
    expect(provider.wasRevoked()).toBe(false);

    await provider.revokeAccess('token');
    expect(provider.wasRevoked()).toBe(true);
  });
});

describe('SyncResult shape', () => {
  it('has the correct fields', () => {
    const result: SyncResult = {
      upserted: 5,
      deleted: 2,
      syncToken: 'new-token',
      tokenExpired: false,
    };

    expect(result.upserted).toBe(5);
    expect(result.deleted).toBe(2);
    expect(result.syncToken).toBe('new-token');
    expect(result.tokenExpired).toBe(false);
  });

  it('tokenExpired can be true', () => {
    const result: SyncResult = {
      upserted: 0,
      deleted: 0,
      syncToken: null,
      tokenExpired: true,
    };

    expect(result.tokenExpired).toBe(true);
    expect(result.syncToken).toBeNull();
  });
});
