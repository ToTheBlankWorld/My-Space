import { createKeyring, generateEncryptionKey } from '@space/auth';
import type { Database } from '@space/database';
import { createLogger } from '@space/logger';
import { FixedClock } from '@space/time';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../oauth', () => ({
  refreshAccessToken: vi.fn(),
}));

import { refreshAccessToken } from '../oauth';
import { resolveConnectionAccessToken } from '../resolve-access-token';
import { decryptCalendarTokens, encryptCalendarTokens } from '../token-store';

/**
 * Behaviour of the worker-side token resolver.
 *
 * The database is faked at the delegate level, because the module under test
 * only touches `calendarConnection.findFirst` and `.update`; a full Prisma
 * double would protect against nothing here and cost a lot to build.
 */

const keyring = createKeyring({ activeKey: generateEncryptionKey('resolver-test') });
const clock = new FixedClock('2026-03-30T09:00:00.000Z');
const logger = createLogger({ name: 'space-calendar-test', level: 'fatal' });

const google = { clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret' };
const CONNECTION_ID = 'conn-1';
const USER_ID = 'user-1';

interface FakeDb {
  db: Database;
  updateCount: () => number;
  lastUpdateData: () => Record<string, unknown> | undefined;
}

const makeDb = (connection: object | null): FakeDb => {
  const state = { updates: [] as Record<string, unknown>[] };

  const db = {
    calendarConnection: {
      findFirst: () => (connection ?? null) as never,
      update: ({ data }: { where: { id: string }; data: Record<string, unknown> }) => {
        state.updates.push(data);
      },
    },
  };

  return {
    db: db as unknown as Database,
    updateCount: () => state.updates.length,
    lastUpdateData: () => state.updates.at(-1),
  };
};

const encrypt = (
  accessToken: string,
  refreshToken: string | null,
  accessTokenExpiresAt: Date | null,
) => encryptCalendarTokens(keyring, { accessToken, refreshToken, accessTokenExpiresAt });

describe('resolveConnectionAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when the connection is missing', async () => {
    const { db } = makeDb(null);
    const result = await resolveConnectionAccessToken(
      { db, logger, clock, keyring, google },
      { userId: USER_ID, connectionId: 'missing' },
    );

    expect(result).toBeNull();
  });

  it('returns null when the connection is not CONNECTED', async () => {
    const { db } = makeDb({ id: CONNECTION_ID, userId: USER_ID, status: 'DISCONNECTED' });
    const result = await resolveConnectionAccessToken(
      { db, logger, clock, keyring, google },
      { userId: USER_ID, connectionId: CONNECTION_ID },
    );

    expect(result).toBeNull();
  });

  it('returns the stored token while it is unexpired, without refreshing', async () => {
    const enc = encrypt('ya29.stored', 'refresh-1', new Date('2026-03-30T10:00:00.000Z'));
    const { db, updateCount } = makeDb({
      id: CONNECTION_ID,
      userId: USER_ID,
      status: 'CONNECTED',
      accessToken: enc.accessToken,
      refreshToken: enc.refreshToken,
      accessTokenExpiresAt: enc.accessTokenExpiresAt,
    });

    const result = await resolveConnectionAccessToken(
      { db, logger, clock, keyring, google },
      { userId: USER_ID, connectionId: CONNECTION_ID },
    );

    expect(result?.accessToken).toBe('ya29.stored');
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(updateCount()).toBe(0);
  });

  it('does not attempt a refresh when no refresh token is stored, even if expired', async () => {
    const enc = encrypt('ya29.expired', null, new Date('2026-03-30T08:00:00.000Z'));
    const { db } = makeDb({
      id: CONNECTION_ID,
      userId: USER_ID,
      status: 'CONNECTED',
      accessToken: enc.accessToken,
      refreshToken: enc.refreshToken,
      accessTokenExpiresAt: enc.accessTokenExpiresAt,
    });

    const result = await resolveConnectionAccessToken(
      { db, logger, clock, keyring, google },
      { userId: USER_ID, connectionId: CONNECTION_ID },
    );

    expect(result?.accessToken).toBe('ya29.expired');
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('refreshes an expired token and persists the new ciphertext', async () => {
    const enc = encrypt('ya29.expired', 'refresh-1', new Date('2026-03-30T08:00:00.000Z'));
    const mockRefresh = vi.mocked(refreshAccessToken);
    mockRefresh.mockResolvedValue({
      accessToken: 'ya29.fresh',
      expiresAt: new Date('2026-03-30T11:00:00.000Z'),
    });

    const { db, updateCount, lastUpdateData } = makeDb({
      id: CONNECTION_ID,
      userId: USER_ID,
      status: 'CONNECTED',
      accessToken: enc.accessToken,
      refreshToken: enc.refreshToken,
      accessTokenExpiresAt: enc.accessTokenExpiresAt,
    });

    const result = await resolveConnectionAccessToken(
      { db, logger, clock, keyring, google },
      { userId: USER_ID, connectionId: CONNECTION_ID },
    );

    expect(result?.accessToken).toBe('ya29.fresh');
    expect(mockRefresh).toHaveBeenCalledWith(
      { clientId: google.clientId, clientSecret: google.clientSecret },
      'refresh-1',
    );

    expect(updateCount()).toBe(1);
    const persisted = lastUpdateData() as { accessToken: string; accessTokenExpiresAt: Date };
    // The database never receives plaintext.
    expect(persisted.accessToken).not.toContain('ya29.fresh');
    expect(
      decryptCalendarTokens(keyring, { accessToken: persisted.accessToken, refreshToken: null })
        .accessToken,
    ).toBe('ya29.fresh');
  });
});
