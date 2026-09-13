import { vi, describe, expect, it, beforeEach } from 'vitest';

/**
 * POST /api/calendar/sync, with the auth/database/producer seams mocked.
 * Pins the contract after the PostgreSQL migration: ownership before enqueue,
 * 202 accepted (never "done"), and no 503-unless-Redis behaviour — the route
 * no longer knows Redis exists.
 */

const REQUIRE_API_USER = vi.fn<() => Promise<{ user: { id: string } }>>();
const REQUIRE_SAME_ORIGIN = vi.fn<(request: Request) => void>();
const SPEND_RATE_LIMIT = vi.fn<(scope: string, key: string) => void>();
const FIND_CONNECTION = vi.fn<() => Promise<{ id: string; status: string } | null>>();
const ENQUEUE = vi.fn<(db: unknown, input: unknown) => Promise<boolean>>();

vi.mock('@/server/api', () => ({
  withApi: (handler: (request: Request) => Promise<Response>) => handler,
  requireApiUser: () => REQUIRE_API_USER(),
  requireSameOrigin: (request: Request) => REQUIRE_SAME_ORIGIN(request),
  spendRateLimit: (scope: string, key: string) => SPEND_RATE_LIMIT(scope, key),
}));

vi.mock('@/server/calendar', () => ({
  getCalendarDatabase: () => ({
    calendarConnection: { findFirst: FIND_CONNECTION },
  }),
  getCalendarLogger: () => ({
    info: vi.fn<(payload: unknown, message?: string) => void>(),
    warn: vi.fn<(payload: unknown, message?: string) => void>(),
    error: vi.fn<(payload: unknown, message?: string) => void>(),
  }),
}));

vi.mock('@/server/calendar-queue', () => ({
  enqueueCalendarSync: (db: unknown, input: unknown) => ENQUEUE(db, input),
}));

import { POST } from './route';

const connectionRow = { id: 'conn_1', status: 'CONNECTED' };

const makeRequest = (body: unknown): Request =>
  new Request('http://localhost:3000/api/calendar/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  REQUIRE_API_USER.mockReset().mockResolvedValue({ user: { id: 'user_1' } });
  REQUIRE_SAME_ORIGIN.mockReset();
  SPEND_RATE_LIMIT.mockReset();
  FIND_CONNECTION.mockReset().mockResolvedValue(connectionRow);
  ENQUEUE.mockReset().mockResolvedValue(true);
});

describe('POST /api/calendar/sync', () => {
  it('returns 202 accepted after enqueueing a durable job', async () => {
    const response = await POST(makeRequest({ connectionId: 'conn_1' }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: 'accepted' });
    expect(ENQUEUE).toHaveBeenCalledTimes(1);
    const [calledDb, input] = ENQUEUE.mock.calls[0]! as [unknown, Record<string, unknown>];
    expect(input).toEqual({
      userId: 'user_1',
      connectionId: 'conn_1',
      calendarId: undefined,
      fullSync: false,
    });
    expect(calledDb).toBeDefined();
  });

  it('enqueues straight to PostgreSQL — no Redis is involved anywhere in the route', async () => {
    // The route module has no Redis code path; the producer writes durable
    // job rows, so acceptance does not depend on any broker being configured.
    const response = await POST(makeRequest({ connectionId: 'conn_1', fullSync: true }));

    expect(response.status).toBe(202);
    expect(ENQUEUE).toHaveBeenCalledTimes(1);
  });

  it('verifies ownership BEFORE enqueueing, and answers 404 for another user’s connection', async () => {
    FIND_CONNECTION.mockResolvedValue(null);

    const response = await POST(makeRequest({ connectionId: 'someone_elses' }));

    expect(response.status).toBe(404);
    expect(ENQUEUE).not.toHaveBeenCalled();
  });

  it('refuses a disconnected connection without enqueueing', async () => {
    FIND_CONNECTION.mockResolvedValue({ id: 'conn_1', status: 'ERROR' });

    const response = await POST(makeRequest({ connectionId: 'conn_1' }));

    expect(response.status).toBe(409);
    expect(ENQUEUE).not.toHaveBeenCalled();
  });

  it('forwards calendar targeting to the producer', async () => {
    await POST(makeRequest({ connectionId: 'conn_1', calendarId: 'cal_9', fullSync: true }));

    const input = ENQUEUE.mock.calls[0]![1] as Record<string, unknown>;
    expect(input.calendarId).toBe('cal_9');
    expect(input.fullSync).toBe(true);
  });

  it('answers 503 only when the durable insert itself fails', async () => {
    ENQUEUE.mockRejectedValue(new Error('database down'));

    const response = await POST(makeRequest({ connectionId: 'conn_1' }));

    expect(response.status).toBe(503);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toContain('not available right now');
  });

  it('answers 400 for a missing connectionId without touching the database', async () => {
    const response = await POST(makeRequest({}));

    expect(response.status).toBe(400);
    expect(FIND_CONNECTION).not.toHaveBeenCalled();
    expect(ENQUEUE).not.toHaveBeenCalled();
  });
});
