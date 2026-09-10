import type { CalendarProvider } from '@space/types';

/**
 * A normalised event from any supported provider.
 *
 * The sync engine consumes only this shape; provider-specific event formats are
 * translated into it by the provider adapter.
 */
export interface NormalizedCalendarEvent {
  /** The provider's unique identifier for this event. */
  externalId: string;
  /** Provider version marker (e.g. Google's ETag) for idempotent upserts. */
  externalEtag?: string | null;
  title: string;
  description?: string | null;
  location?: string | null;
  /** The event start as an ISO-8601 instant. */
  startAt: Date;
  /** The event end as an ISO-8601 instant. */
  endAt: Date;
  /** IANA timezone the event was authored in. */
  timeZone: string;
  /** True for events with no time component (e.g. "Christmas Day"). */
  isAllDay: boolean;
  /** CONFIRMED, TENTATIVE, or CANCELLED. */
  status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
  /** The provider event id of the recurring series this instance belongs to. */
  recurringEventId?: string | null;
  /** For instances of a recurring event, the original start time. */
  originalStartAt?: Date | null;
  /** The RFC 3339 timestamp the provider last modified this event. */
  updatedAt?: Date | null;
}

/**
 * A calendar discovered from the provider.
 */
export interface ProviderCalendar {
  externalId: string;
  name: string;
  description?: string | null;
  timeZone: string;
  isPrimary: boolean;
  color?: string | null;
}

/**
 * Result of an incremental sync pass.
 */
export interface SyncResult {
  /** Events created or updated. */
  upserted: number;
  /** Events tombstoned (deleted upstream). */
  deleted: number;
  /** The new sync token, or null if the provider did not return one. */
  syncToken: string | null;
  /** True when the token expired and a full re-sync is needed. */
  tokenExpired: boolean;
}

/**
 * The contract every calendar provider must satisfy.
 *
 * Space never calls Google directly — all provider interaction goes through this
 * interface, which makes the sync engine testable with deterministic fakes.
 */
export interface CalendarProviderAdapter {
  /** Which provider this adapter handles. */
  readonly provider: CalendarProvider;

  /** Discovers calendars the user has access to. */
  listCalendars(accessToken: string): Promise<ProviderCalendar[]>;

  /**
   * Fetches events from a calendar.
   *
   * When `syncToken` is provided, performs an incremental sync. When null,
   * performs a full fetch (bounded by timeRange).
   */
  listEvents(
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
  }>;

  /** Revokes the application's access (best-effort, does not throw). */
  revokeAccess(accessToken: string): Promise<void>;
}
