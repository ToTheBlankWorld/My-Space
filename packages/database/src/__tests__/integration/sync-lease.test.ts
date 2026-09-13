import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import type { DatabaseClient } from '../../client';
import * as calendar from '../../repositories/calendar';
import * as syncLease from '../../repositories/sync-lease';
import * as users from '../../repositories/users';
import { cleanupTestData, createTestClient, describeIntegration, testEmail } from './setup';

/**
 * The calendar sync lease — the PostgreSQL replacement for the Redis
 * `SET NX EX` lock — must behave identically to what the sync worker relies
 * on today: atomic mutual exclusion, TTL expiry, an owner token, and a
 * release that can never clear a successor's lease.
 */

describeIntegration('calendar sync lease', () => {
  let db: DatabaseClient;
  let second: DatabaseClient;

  const newConnection = async (label: string) => {
    const user = await users.createUser(db, { email: testEmail(label), name: 'Test Person' });
    return calendar.upsertCalendarConnection(db, user.id, {
      provider: 'GOOGLE',
      providerAccountId: `account-${label}`,
    });
  };

  beforeAll(() => {
    db = createTestClient();
    second = createTestClient();
  });

  beforeEach(async () => {
    await cleanupTestData(db);
  });

  afterAll(async () => {
    await cleanupTestData(db);
    await db.$disconnect();
    await second.$disconnect();
  });

  it('acquires an idle connection, and refuses a second acquirer while the lease is live', async () => {
    const connection = await newConnection('lease-basic');

    expect(
      await syncLease.acquireConnectionSyncLease(db, {
        connectionId: connection.id,
        owner: 'owner-a',
        ttlMs: 240_000,
      }),
    ).toBe(true);

    const held = await syncLease.getConnectionSyncLease(db, connection.id);
    expect(held.owner).toBe('owner-a');
    expect(held.until!.getTime()).toBeGreaterThan(Date.now());

    expect(
      await syncLease.acquireConnectionSyncLease(second, {
        connectionId: connection.id,
        owner: 'owner-b',
        ttlMs: 240_000,
      }),
    ).toBe(false);
    expect((await syncLease.getConnectionSyncLease(db, connection.id)).owner).toBe('owner-a');
  });

  it('releases only for the owning token', async () => {
    const connection = await newConnection('lease-release');
    await syncLease.acquireConnectionSyncLease(db, {
      connectionId: connection.id,
      owner: 'owner-a',
      ttlMs: 240_000,
    });

    expect(
      await syncLease.releaseConnectionSyncLease(db, { connectionId: connection.id, owner: 'owner-b' }),
    ).toBe(false);
    expect((await syncLease.getConnectionSyncLease(db, connection.id)).owner).toBe('owner-a');

    expect(
      await syncLease.releaseConnectionSyncLease(db, { connectionId: connection.id, owner: 'owner-a' }),
    ).toBe(true);

    const cleared = await syncLease.getConnectionSyncLease(db, connection.id);
    expect(cleared).toEqual({ owner: null, until: null });
  });

  it('lets a new owner take over an expired lease, and blocks the old owner from releasing it', async () => {
    const connection = await newConnection('lease-expiry');
    await syncLease.acquireConnectionSyncLease(db, {
      connectionId: connection.id,
      owner: 'owner-a',
      ttlMs: 240_000,
    });

    // Simulate the TTL lapsing (a crashed worker's lease aging out).
    await db.calendarConnection.update({
      where: { id: connection.id },
      data: { syncLeaseUntil: new Date(Date.now() - 1_000) },
    });

    expect(
      await syncLease.acquireConnectionSyncLease(second, {
        connectionId: connection.id,
        owner: 'owner-b',
        ttlMs: 240_000,
      }),
    ).toBe(true);

    // The crashed owner wakes up and tries to release: it must not clear the
    // successor's lease.
    expect(
      await syncLease.releaseConnectionSyncLease(db, { connectionId: connection.id, owner: 'owner-a' }),
    ).toBe(false);
    expect((await syncLease.getConnectionSyncLease(db, connection.id)).owner).toBe('owner-b');
  });

  it('gives exactly one winner when two processes contend for the same idle connection', async () => {
    const connection = await newConnection('lease-contention');

    const [a, b] = await Promise.all([
      syncLease.acquireConnectionSyncLease(db, {
        connectionId: connection.id,
        owner: 'owner-a',
        ttlMs: 240_000,
      }),
      syncLease.acquireConnectionSyncLease(second, {
        connectionId: connection.id,
        owner: 'owner-b',
        ttlMs: 240_000,
      }),
    ]);

    // Exactly one acquirer won; the winner is recorded on the row.
    expect([a, b].filter((won) => won)).toHaveLength(1);
    const holder = await syncLease.getConnectionSyncLease(db, connection.id);
    expect(holder.owner === 'owner-a' || holder.owner === 'owner-b').toBe(true);
  });
});
