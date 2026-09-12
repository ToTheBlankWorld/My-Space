import type { Database } from '@space/database';
import { createLogger } from '@space/logger';
import { FixedClock } from '@space/time';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarTransientError } from '../errors';
import { discoverCalendarsForConnection, syncAllCalendars, type SyncContext } from '../sync';
import type { CalendarProviderAdapter, NormalizedCalendarEvent, ProviderCalendar } from '../types';

/**
 * Calendar self-heal behaviour.
 *
 * A `CONNECTED` connection can legitimately have an empty mirror: the web
 * callback's discovery is best-effort, so a transient Google failure leaves the
 * connection connected with zero mirrored calendars — and the periodic sync
 * would have nothing to act on. These tests prove that `syncAllCalendars`
 * discovers calendars on the fly (via `discoverCalendarsForConnection`), that a
 * discovery failure is observable through the typed connection-event log, and
 * that a later retry recovers without changing normal sync behaviour for
 * connections that already have mirrors.
 *
 * The database is faked at the delegate level, matching the pattern in
 * `resolve-access-token.test.ts`: the module under test touches a small, fixed
 * set of Prisma model accessors, and a full double would protect against
 * nothing here.
 */

const USER_ID = 'user-0001';
const CONNECTION_ID = 'connection-01';
const ACCESS_TOKEN = 'ya29.self-heal';
const CLOCK = new FixedClock('2026-03-30T09:00:00.000Z');
const LOGGER = createLogger({ name: 'space-calendar-test', level: 'fatal' });

const CONNECTED_CONNECTION = {
  id: CONNECTION_ID,
  userId: USER_ID,
  status: 'CONNECTED',
  syncCursor: null,
  accessTokenExpiresAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
} as const;

const SAMPLE_CALENDARS: ProviderCalendar[] = [
  { externalId: 'primary@example.com', name: 'Primary', timeZone: 'UTC', isPrimary: true },
  {
    externalId: 'work@example.com',
    name: 'Work',
    timeZone: 'America/New_York',
    isPrimary: false,
    description: 'Work calendar',
    color: '#039be5',
  },
];

const makeEvent = (externalId: string): NormalizedCalendarEvent => ({
  externalId,
  title: `Event ${externalId}`,
  startAt: new Date('2026-03-30T09:00:00.000Z'),
  endAt: new Date('2026-03-30T10:00:00.000Z'),
  timeZone: 'UTC',
  isAllDay: false,
  status: 'CONFIRMED',
});

interface CalendarRow {
  id: string;
  userId: string;
  connectionId: string;
  externalId: string;
  name: string;
  description: string | null;
  timeZone: string;
  isPrimary: boolean;
  isSelected: boolean;
  color: string | null;
}

interface FakeDbHandles {
  db: Database;
  store: {
    calendars: CalendarRow[];
    events: NormalizedCalendarEvent[];
    eventLog: Array<Record<string, unknown>>;
    connectionUpdates: Array<Record<string, unknown>>;
  };
}

const makeFakeDb = (initial: { connection: unknown; calendars?: CalendarRow[] }): FakeDbHandles => {
  const store = {
    calendars: [...(initial.calendars ?? [])],
    events: [] as NormalizedCalendarEvent[],
    eventLog: [] as Array<Record<string, unknown>>,
    connectionUpdates: [] as Array<Record<string, unknown>>,
  };

  let calendarCounter = store.calendars.length;

  const db = {
    calendarConnection: {
      findFirst: ({ where }: { where: { id: string; userId: string } }) =>
        where.id === CONNECTION_ID && where.userId === USER_ID ? initial.connection : null,
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        store.connectionUpdates.push(data);
        return { id: where.id, ...data };
      },
      updateMany: () => ({ count: 0 }),
    },
    calendar: {
      count: ({ where }: { where: { connectionId: string; userId: string } }) =>
        store.calendars.filter(
          (c) => c.connectionId === where.connectionId && c.userId === where.userId,
        ).length,
      findMany: ({
        where,
      }: {
        where: { connectionId: string; userId: string; isSelected?: boolean };
      }) =>
        store.calendars.filter(
          (c) =>
            c.connectionId === where.connectionId &&
            c.userId === where.userId &&
            (where.isSelected === undefined || c.isSelected === where.isSelected),
        ),
      findFirst: ({ where }: { where: { id: string; connectionId: string; userId: string } }) =>
        store.calendars.find(
          (c) =>
            c.id === where.id && c.connectionId === where.connectionId && c.userId === where.userId,
        ) ?? null,
      upsert: ({
        where,
        create,
      }: {
        where: { connectionId_externalId: { connectionId: string; externalId: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const existing = store.calendars.find(
          (c) =>
            c.connectionId === where.connectionId_externalId.connectionId &&
            c.externalId === where.connectionId_externalId.externalId,
        );
        if (existing) {
          const merged = { ...existing, ...(create as unknown as CalendarRow) };
          store.calendars[store.calendars.indexOf(existing)] = merged;
          return merged;
        }
        const row = {
          id: `calendar-row-${++calendarCounter}`,
          ...create,
        } as unknown as CalendarRow;
        store.calendars.push(row);
        return row;
      },
    },
    calendarEvent: {
      upsert: ({ create }: { create: Record<string, unknown> }) => {
        const event = create as unknown as NormalizedCalendarEvent;
        store.events.push(event);
        return event;
      },
      updateMany: () => ({ count: 0 }),
    },
    eventLog: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        store.eventLog.push(data);
        return data;
      },
    },
  };

  return { db: db as unknown as Database, store };
};

interface Harness {
  ctx: SyncContext;
  provider: CalendarProviderAdapter;
  listCalendars: ReturnType<typeof vi.fn>;
  listEvents: ReturnType<typeof vi.fn>;
  store: FakeDbHandles['store'];
}

const buildHarness = (overrides?: {
  connection?: unknown;
  calendars?: CalendarRow[];
  listCalendars?: () => Promise<ProviderCalendar[]>;
  listEvents?: () => Promise<{
    events: NormalizedCalendarEvent[];
    syncToken: string | null;
    tokenExpired: boolean;
  }>;
}): Harness => {
  const listCalendars = vi.fn(
    overrides?.listCalendars ?? (() => Promise.resolve(SAMPLE_CALENDARS)),
  );
  const listEvents = vi.fn(
    overrides?.listEvents ??
      (() =>
        Promise.resolve({
          events: [makeEvent('evt-1')],
          syncToken: 'tok-1',
          tokenExpired: false,
        })),
  );
  const revokeAccess = vi.fn(() => Promise.resolve());

  const provider = {
    provider: 'GOOGLE' as const,
    listCalendars,
    listEvents,
    revokeAccess,
  } as unknown as CalendarProviderAdapter;

  const { db, store } = makeFakeDb({
    connection: overrides?.connection ?? CONNECTED_CONNECTION,
    calendars: overrides?.calendars,
  });

  const ctx: SyncContext = { db, logger: LOGGER, clock: CLOCK, provider };

  return { ctx, provider, listCalendars, listEvents, store };
};

describe('discoverCalendarsForConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('discovers calendars from the provider when the mirror is empty', async () => {
    const { ctx, listCalendars, store } = buildHarness();

    const count = await discoverCalendarsForConnection(ctx, {
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      accessToken: ACCESS_TOKEN,
    });

    expect(count).toBe(SAMPLE_CALENDARS.length);
    expect(listCalendars).toHaveBeenCalledOnce();
    expect(listCalendars).toHaveBeenCalledWith(ACCESS_TOKEN);
    expect(store.calendars).toHaveLength(SAMPLE_CALENDARS.length);
  });

  it('upserts discovered calendars through the repository, preserving isSelected', async () => {
    const { ctx, store } = buildHarness();

    await discoverCalendarsForConnection(ctx, {
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      accessToken: ACCESS_TOKEN,
    });

    const primary = store.calendars.find((c) => c.externalId === 'primary@example.com');
    expect(primary).toMatchObject({
      connectionId: CONNECTION_ID,
      userId: USER_ID,
      externalId: 'primary@example.com',
      name: 'Primary',
      timeZone: 'UTC',
      isPrimary: true,
      isSelected: true,
      color: null,
    });

    const work = store.calendars.find((c) => c.externalId === 'work@example.com');
    expect(work).toMatchObject({
      name: 'Work',
      timeZone: 'America/New_York',
      isPrimary: false,
      // The repository's default selection is preserved for newly mirrored rows.
      isSelected: true,
      description: 'Work calendar',
      color: '#039be5',
    });
  });

  it('records a typed connection failure event and rethrows when discovery fails', async () => {
    const { ctx, listCalendars, store } = buildHarness({
      listCalendars: () => Promise.reject(new CalendarTransientError('google was unreachable')),
    });

    await expect(
      discoverCalendarsForConnection(ctx, {
        userId: USER_ID,
        connectionId: CONNECTION_ID,
        accessToken: ACCESS_TOKEN,
      }),
    ).rejects.toThrow(CalendarTransientError);

    const failure = store.eventLog.find((e) => e.eventType === 'CALENDAR_SYNC_FAILED');
    expect(failure).toBeDefined();
    const payload = failure?.payload as Record<string, unknown>;
    expect(payload.reason).toBe('calendar-discovery-failed');
    expect(payload.message).toBe('google was unreachable');
    expect(failure?.aggregateId).toBe(CONNECTION_ID);
    expect(listCalendars).toHaveBeenCalledOnce();
  });
});

describe('syncAllCalendars self-heal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs discovery for a CONNECTED connection with zero calendars, then syncs events', async () => {
    const { ctx, listCalendars, store } = buildHarness();

    const results = await syncAllCalendars(ctx, {
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      accessToken: ACCESS_TOKEN,
    });

    // Discovery ran because the mirror was empty.
    expect(listCalendars).toHaveBeenCalledOnce();
    expect(store.calendars).toHaveLength(SAMPLE_CALENDARS.length);

    // Every discovered calendar was then event-synced (one event each).
    expect(results).toHaveLength(SAMPLE_CALENDARS.length);
    const upserted = results.reduce((sum, { result }) => sum + result.upserted, 0);
    expect(upserted).toBe(SAMPLE_CALENDARS.length);
    expect(store.events).toHaveLength(SAMPLE_CALENDARS.length);
  });

  it('recovers on the next periodic run after a failed discovery, clearing residual error state', async () => {
    let attempts = 0;
    const { ctx, listCalendars, store } = buildHarness({
      listCalendars: () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new CalendarTransientError('first attempt failed'));
        }
        return Promise.resolve(SAMPLE_CALENDARS);
      },
    });

    // First periodic run: discovery fails, surfaced as a typed event + rejection.
    await expect(
      syncAllCalendars(ctx, {
        userId: USER_ID,
        connectionId: CONNECTION_ID,
        accessToken: ACCESS_TOKEN,
      }),
    ).rejects.toThrow(CalendarTransientError);

    expect(store.eventLog.some((e) => e.eventType === 'CALENDAR_SYNC_FAILED')).toBe(true);

    // Next periodic run: discovery succeeds, calendars are mirrored and synced.
    const results = await syncAllCalendars(ctx, {
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      accessToken: ACCESS_TOKEN,
    });

    expect(listCalendars).toHaveBeenCalledTimes(2);
    expect(store.calendars).toHaveLength(SAMPLE_CALENDARS.length);
    expect(results).toHaveLength(SAMPLE_CALENDARS.length);
    expect(results.every(({ result }) => result.upserted === 1)).toBe(true);

    // A successful sync clears the residual error state on the connection.
    const lastUpdate = store.connectionUpdates.at(-1);
    expect(lastUpdate).toMatchObject({
      lastErrorAt: null,
      lastErrorMessage: null,
      status: 'CONNECTED',
    });
  });

  it('leaves connections that already have mirrors untouched (no discovery)', async () => {
    const existing: CalendarRow = {
      id: 'calendar-row-9',
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      externalId: 'primary@example.com',
      name: 'Primary',
      description: null,
      timeZone: 'UTC',
      isPrimary: true,
      isSelected: true,
      color: null,
    };

    const { ctx, listCalendars, store } = buildHarness({
      calendars: [existing],
      listCalendars: () => Promise.resolve(SAMPLE_CALENDARS),
    });

    const results = await syncAllCalendars(ctx, {
      userId: USER_ID,
      connectionId: CONNECTION_ID,
      accessToken: ACCESS_TOKEN,
    });

    // Normal sync: only the pre-existing (selected) calendar is synced.
    expect(listCalendars).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    const only = results[0];
    if (!only) {
      throw new Error('expected one sync result');
    }
    expect(only.calendarId).toBe(existing.id);
    expect(only.result.upserted).toBe(1);
    expect(store.calendars).toHaveLength(1);
    expect(store.events).toHaveLength(1);
  });
});
