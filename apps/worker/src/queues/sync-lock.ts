import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

/**
 * Per-connection sync lock.
 *
 * BullMQ guarantees one *job* is not processed twice in one worker, but two
 * processes (a rolling deploy) each running a worker could pick up a sync for
 * the same connection at the same time. Two concurrent syncs for one connection
 * would interleave read-modified-write on the same sync cursor and could
 * duplicate or drop events.
 *
 * A Redis `SET NX EX` key, one per connection, is the mutual exclusion: the
 * second processor that tries to acquire it returns `false` and abandons the
 * job without retry — the first will have written the same state.
 */

export interface ConnectionSyncLock {
  /** True when this process holds the lock. */
  acquire: () => Promise<boolean>;
  /** Releases the lock only if this process still owns it. */
  release: () => Promise<void>;
}

export const createConnectionSyncLock = (
  redis: Redis,
  connectionId: string,
  ttlMs = 4 * 60 * 1000,
): ConnectionSyncLock => {
  const key = `space:calendar-sync:lock:${connectionId}`;
  const owner = randomBytes(16).toString('hex');

  return {
    acquire: async () => {
      const result = await redis.set(key, owner, 'EX', Math.ceil(ttlMs / 1000), 'NX');
      return result === 'OK';
    },
    release: async () => {
      // Only release when we still own the key; a TTL expiry that lets a
      // successor acquire it must not make this process delete the successor's
      // lock.
      const current = await redis.get(key);
      if (current === owner) {
        await redis.del(key);
      }
    },
  };
};
