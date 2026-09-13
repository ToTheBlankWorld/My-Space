import { randomBytes } from 'node:crypto';

import { syncLease, type Database } from '@space/database';

import type { SyncLock } from './calendar-sync';

/**
 * The per-connection sync lock, shaped as the processor-level `SyncLock` seam.
 *
 * Delegates to the `syncLease` repository: an atomic conditional UPDATE
 * against the database clock, ~4-minute TTL, random owner token, owner-checked
 * release, expired-lease takeover. This is the ONLY calendar synchronization
 * lock — the Redis lock it replaced is gone.
 */
export const createDatabaseConnectionSyncLock = (
  db: Database,
  connectionId: string,
  ttlMs = 4 * 60 * 1000,
): SyncLock => {
  const owner = randomBytes(16).toString('hex');

  return {
    acquire: () =>
      syncLease.acquireConnectionSyncLease(db, { connectionId, owner, ttlMs }),
    release: () =>
      syncLease.releaseConnectionSyncLease(db, { connectionId, owner }).then(() => undefined),
  };
};
