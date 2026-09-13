import type { Database } from '../client';
import { withDomainErrors } from '../errors';

/**
 * Per-connection calendar sync lease.
 *
 * PostgreSQL replacement for the Redis `SET NX EX` lock in the worker's sync
 * pipeline. Two processes must never sync one connection concurrently: they
 * would interleave read-modified-write on the same sync cursor and could
 * duplicate or drop events. The lease is two columns on `CalendarConnection`:
 * a random per-attempt owner token and a TTL timestamp.
 *
 * Semantics match the Redis lock exactly:
 *
 *  - Acquire is one atomic conditional `UPDATE` — a second acquirer while the
 *    lease is live matches no row and returns false.
 *  - An expired lease (`syncLeaseUntil` in the past) is freely acquirable.
 *  - Release is owner-checked: an old owner whose lease expired and was taken
 *    over can never clear the successor's lease, because the owner token no
 *    longer matches.
 *
 * All expiry arithmetic uses the database clock, so a skewed or paused worker
 * process cannot extend or steal a lease by accident. The default TTL mirrors
 * the Redis lock's 4 minutes.
 */

/** The current lease holder, or null when the connection holds no lease. */
export interface ConnectionSyncLease {
  owner: string | null;
  until: Date | null;
}

export interface AcquireSyncLeaseInput {
  connectionId: string;
  /** Random token generated once per sync attempt; never a process identity. */
  owner: string;
  /** Lease TTL in milliseconds (the Redis lock used 4 minutes). */
  ttlMs: number;
}

/**
 * Acquires the sync lease for one calendar connection.
 *
 * Returns true only when this call took the lease: the connection was idle
 * (`syncLeaseUntil` null) or its previous lease had expired. All within one
 * UPDATE, so two concurrent acquirers get exactly one true.
 */
export const acquireConnectionSyncLease = async (
  db: Database,
  { connectionId, owner, ttlMs }: AcquireSyncLeaseInput,
): Promise<boolean> =>
  withDomainErrors('CalendarConnection', async () => {
    const updated = await db.$executeRaw`
      UPDATE "calendar_connections" SET
        "syncLeaseOwner" = ${owner},
        "syncLeaseUntil" = now() + (${Math.ceil(ttlMs / 1000)}::int * interval '1 second'),
        "updatedAt" = now()
      WHERE "id" = ${connectionId}
        AND ("syncLeaseUntil" IS NULL OR "syncLeaseUntil" <= now())
    `;
    return updated === 1;
  });

/**
 * Releases the sync lease — but only if `owner` still holds it.
 *
 * Returns true when the lease was cleared, false when someone else owns it
 * (a takeover after TTL expiry) or when there was nothing to release. Not
 * releasing a successor's lease is the whole point of the owner token.
 */
export const releaseConnectionSyncLease = async (
  db: Database,
  { connectionId, owner }: { connectionId: string; owner: string },
): Promise<boolean> =>
  withDomainErrors('CalendarConnection', async () => {
    const updated = await db.$executeRaw`
      UPDATE "calendar_connections" SET
        "syncLeaseOwner" = NULL,
        "syncLeaseUntil" = NULL,
        "updatedAt" = now()
      WHERE "id" = ${connectionId} AND "syncLeaseOwner" = ${owner}
    `;
    return updated === 1;
  });

/** Reads the current lease state, for diagnostics and tests. */
export const getConnectionSyncLease = async (
  db: Database,
  connectionId: string,
): Promise<ConnectionSyncLease> => {
  const row = await db.calendarConnection.findUnique({
    where: { id: connectionId },
    select: { syncLeaseOwner: true, syncLeaseUntil: true },
  });
  return { owner: row?.syncLeaseOwner ?? null, until: row?.syncLeaseUntil ?? null };
};
