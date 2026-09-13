import type { Database } from '../client';
import { withDomainErrors } from '../errors';
import { type Prisma } from '../generated/prisma/client';

/**
 * The durable background job store.
 *
 * The durable background job store. The row is the job: workers claim it with
 * one atomic `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`, retries
 * are re-dated through `runAt`, crashed workers are recovered by the reaper
 * through the `lockExpiresAt` lease, and deduplication/coalescing are enforced
 * by the unique `dedupeKey`.
 *
 * Two correctness rules hold throughout:
 *
 *  - *Database time, not process time.* Lease expiry and schedule cadence are
 *    computed inside SQL against `now()`. A paused or skewed worker clock can
 *    never steal a lease or fire a schedule early; it can only affect when its
 *    poll loop wakes up.
 *  - *Compare-and-swap transitions.* Every state change carries the state it
 *    expects in its `WHERE` clause, so a reaper, a retrying worker and a
 *    coalescing producer can interleave without corrupting a row.
 *
 * No worker or business logic lives here — the processors decide *what* a job
 * means; this file decides *where it lives*.
 */

/** Upper bound on one backoff step. Failures wait minutes, not hours. */
export const MAX_BACKOFF_MS = 10 * 60_000;

/** Upper bound for a stored error string; mirrors the audit trail's cap. */
const MAX_ERROR_LENGTH = 500;

export interface EnqueueJobInput {
  queue: string;
  name: string;
  payload: Prisma.InputJsonValue;
  /** Lower runs first. Align with the domain's urgency conventions (0 = urgent). */
  priority?: number;
  /** Earliest claim time. Callers pass their injected clock's instant — this
   * repository never reads the process clock; all *correctness* arithmetic
   * (lease expiry, backoff anchoring, schedule cadence) happens in the database. */
  runAt: Date;
  maxAttempts?: number;
  backoffBaseMs?: number;
}

export interface DedupeEnqueueOptions {
  /**
   * Re-arm the dedupe slot when the existing job is terminal (COMPLETED, DEAD,
   * CANCELLED): the row resets to PENDING with the new payload, a fresh attempt
   * budget and a cleared error. Without it, a terminal duplicate suppresses the
   * enqueue — dedupe is a slot, never a global permanent suppression, because
   * the maintenance prune eventually frees terminal rows' keys and `rearm`
   * covers the "fire again now" cases.
   */
  rearm?: boolean;
}

export type EnqueueDedupedOutcome = 'created' | 'duplicate' | 'rearmed';

export type CoalesceOutcome =
  | 'created'
  | 'coalesced'
  | 'duplicate'
  | 'suppressed-running'
  | 'suppressed-terminal'
  | 'rearmed';

export interface ClaimInput {
  queue: string;
  /** Identifies the claiming worker instance; the lease is renewed per owner. */
  workerId: string;
  /** Lease duration in seconds; the reaper recovers jobs whose lease lapses. */
  leaseSeconds: number;
  limit: number;
}

export interface FailOptions {
  /** Ceiling for one backoff step. */
  backoffCapMs?: number;
}

export type FailOutcome = 'retry' | 'dead' | 'not-found' | 'not-running';

export interface QueueDepthRow {
  queue: string;
  status: string;
  count: number;
}

export interface ReapResult {
  /** Expired RUNNING jobs returned to PENDING with budget left. */
  reaped: number;
  /** Expired RUNNING jobs whose budget was exhausted — dead-lettered. */
  dead: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * One exponential backoff step: `base * 2^(attempts - 1)`, capped.
 *
 * `attempts` is the count *after* the failing claim (claim increments it), so
 * the first failure waits one base interval and each subsequent failure doubles.
 */
export const computeBackoffDelayMs = (
  attempts: number,
  backoffBaseMs: number,
  capMs: number = MAX_BACKOFF_MS,
): number => {
  const step = attempts - 1;
  if (step <= 0) {
    return Math.min(backoffBaseMs, capMs);
  }
  // The exponent is bounded in practice (maxAttempts is small), but shift past
  // 30 would overflow — clamp before doubling.
  const factor = 2 ** Math.min(step, 30);
  return Math.min(backoffBaseMs * factor, capMs);
};

/**
 * Normalises any thrown value into a storable error string: bounded, honest
 * about the error type, and never a stack trace. Secrets are kept out by
 * construction — processors must not put credentials in error messages, the
 * same rule the audit trail applies to `reason`.
 */
export const normalizeJobError = (error: unknown): string => {
  let text: string;
  if (error instanceof Error) {
    text = `${error.name}: ${error.message}`;
  } else if (typeof error === 'string' && error.length > 0) {
    text = error;
  } else {
    text = 'unknown failure';
  }
  return text.slice(0, MAX_ERROR_LENGTH);
};

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/** Enqueues a new job. Always inserts a fresh row; use with no `dedupeKey`. */
export const enqueueJob = async (db: Database, input: EnqueueJobInput) =>
  withDomainErrors('BackgroundJob', () =>
    db.backgroundJob.create({
      data: {
        queue: input.queue,
        name: input.name,
        payload: input.payload,
        priority: input.priority ?? 100,
        runAt: input.runAt,
        maxAttempts: input.maxAttempts ?? 3,
        backoffBaseMs: input.backoffBaseMs ?? 10_000,
      },
    }),
  );

/**
 * Enqueues with insert-if-absent deduplication on `dedupeKey`.
 *
 * A PENDING or RUNNING duplicate suppresses the enqueue untouched. A terminal
 * duplicate (COMPLETED, DEAD, CANCELLED) suppresses too — unless `rearm` is
 * set, which explicitly resets the slot to PENDING with the new payload.
 */
export const enqueueDedupedJob = async (
  db: Database,
  input: EnqueueJobInput & { dedupeKey: string },
  options: DedupeEnqueueOptions = {},
): Promise<{ job: Prisma.BackgroundJobGetPayload<object>; outcome: EnqueueDedupedOutcome }> =>
  withDomainErrors('BackgroundJob', () =>
    db.$transaction(async (tx) => {
      const existing = await tx.backgroundJob.findUnique({
        where: { dedupeKey: input.dedupeKey },
      });

      if (!existing) {
        const job = await tx.backgroundJob.create({
          data: {
            queue: input.queue,
            name: input.name,
            payload: input.payload,
            priority: input.priority ?? 100,
            runAt: input.runAt,
            maxAttempts: input.maxAttempts ?? 3,
            backoffBaseMs: input.backoffBaseMs ?? 10_000,
            dedupeKey: input.dedupeKey,
          },
        });
        return { job, outcome: 'created' as const };
      }

      const rearmable =
        options.rearm === true &&
        existing.status !== 'PENDING' &&
        existing.status !== 'RUNNING';

      if (rearmable) {
        const rearmed = await tx.backgroundJob.update({
          where: { id: existing.id },
          data: {
            status: 'PENDING',
            payload: input.payload,
            runAt: input.runAt,
            attempts: 0,
            lastError: null,
            lockedBy: null,
            lockExpiresAt: null,
            completedAt: null,
          },
        });
        return { job: rearmed, outcome: 'rearmed' as const };
      }

      return { job: existing, outcome: 'duplicate' as const };
    }),
  );

/**
 * Enqueues-or-coalesces on `dedupeKey`: the "replace a PENDING job with newer
 * payload/runAt" primitive the autonomous replan loop needs.
 *
 *  - No row          → created.
 *  - PENDING         → replaced: new payload/runAt, fresh attempt budget.
 *  - RUNNING         → never touched; the in-flight attempt finishes and the
 *                      caller may coalesce again on the next pass.
 *  - COMPLETED/DEAD/
 *    CANCELLED       → never silently resurrected; `rearm` is the explicit opt-in.
 */
export const coalesceJob = async (
  db: Database,
  input: EnqueueJobInput & { dedupeKey: string },
  options: DedupeEnqueueOptions = {},
): Promise<{ job: Prisma.BackgroundJobGetPayload<object>; outcome: CoalesceOutcome }> =>
  withDomainErrors('BackgroundJob', () =>
    db.$transaction(async (tx) => {
      const existing = await tx.backgroundJob.findUnique({
        where: { dedupeKey: input.dedupeKey },
      });

      if (!existing) {
        const job = await tx.backgroundJob.create({
          data: {
            queue: input.queue,
            name: input.name,
            payload: input.payload,
            priority: input.priority ?? 100,
            runAt: input.runAt,
            maxAttempts: input.maxAttempts ?? 3,
            backoffBaseMs: input.backoffBaseMs ?? 10_000,
            dedupeKey: input.dedupeKey,
          },
        });
        return { job, outcome: 'created' as const };
      }

      if (existing.status === 'PENDING') {
        // CAS on the status: a concurrent claim must not have the coalesce
        // clobber a row that just went RUNNING.
        const coalesced = await tx.backgroundJob.updateMany({
          where: { id: existing.id, status: 'PENDING' },
          data: {
            payload: input.payload,
            runAt: input.runAt,
            priority: input.priority ?? existing.priority,
            attempts: 0,
            lastError: null,
          },
        });
        if (coalesced.count === 1) {
          const job = await tx.backgroundJob.findUniqueOrThrow({
            where: { id: existing.id },
          });
          return { job, outcome: 'coalesced' as const };
        }
        const job = await tx.backgroundJob.findUniqueOrThrow({
          where: { id: existing.id },
        });
        return { job, outcome: 'suppressed-running' as const };
      }

      if (existing.status === 'RUNNING') {
        return { job: existing, outcome: 'suppressed-running' as const };
      }

      if (options.rearm === true) {
        const rearmed = await tx.backgroundJob.update({
          where: { id: existing.id },
          data: {
            status: 'PENDING',
            payload: input.payload,
            runAt: input.runAt,
            attempts: 0,
            lastError: null,
            lockedBy: null,
            lockExpiresAt: null,
            completedAt: null,
          },
        });
        return { job: rearmed, outcome: 'rearmed' as const };
      }

      return { job: existing, outcome: 'suppressed-terminal' as const };
    }),
  );

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

/**
 * Atomically claims up to `limit` due jobs from one queue.
 *
 * A single statement: the inner `SELECT … FOR UPDATE SKIP LOCKED` locks the
 * winning rows, so two concurrent claimers can never take the same job; the
 * outer `UPDATE` marks them RUNNING with a fresh lease. All time comparisons
 * (`runAt <= now()`, lease expiry) are evaluated against the database clock.
 */
export const claimJobs = async (
  db: Database,
  { queue, workerId, leaseSeconds, limit }: ClaimInput,
): Promise<Prisma.BackgroundJobGetPayload<object>[]> =>
  withDomainErrors('BackgroundJob', async () => {
    const rows = await db.$queryRaw<Prisma.BackgroundJobGetPayload<object>[]>`
      UPDATE "background_jobs" SET
        "status" = 'RUNNING',
        "attempts" = "attempts" + 1,
        "lockedBy" = ${workerId},
        "lockExpiresAt" = now() + (${Math.ceil(leaseSeconds)}::int * interval '1 second'),
        "updatedAt" = now()
      WHERE "id" IN (
        SELECT "id" FROM "background_jobs"
        WHERE "status" = 'PENDING'
          AND "queue" = ${queue}
          AND "runAt" <= now()
        ORDER BY "priority" ASC, "runAt" ASC, "id" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *;
    `;
    return rows;
  });

/**
 * Extends a RUNNING job's lease, owner-checked. Long processors heartbeat this
 * (roughly every third of the lease) so a legitimately slow job is never reaped.
 */
export const renewJobLease = async (
  db: Database,
  jobId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<boolean> =>
  withDomainErrors('BackgroundJob', async () => {
    const updated = await db.$executeRaw`
      UPDATE "background_jobs" SET
        "lockExpiresAt" = now() + (${Math.ceil(leaseSeconds)}::int * interval '1 second'),
        "updatedAt" = now()
      WHERE "id" = ${jobId} AND "status" = 'RUNNING' AND "lockedBy" = ${workerId}
    `;
    return updated === 1;
  });

// ---------------------------------------------------------------------------
// Completion, failure, cancellation
// ---------------------------------------------------------------------------

/**
 * Marks a RUNNING job COMPLETED. Returns false when this worker no longer
 * holds it (a reaper already recovered the row). `completedAt` comes from the
 * caller's injected clock, matching the repository convention.
 */
export const completeJob = async (
  db: Database,
  jobId: string,
  completedAt: Date,
): Promise<boolean> =>
  withDomainErrors('BackgroundJob', async () => {
    const result = await db.backgroundJob.updateMany({
      where: { id: jobId, status: 'RUNNING' },
      data: { status: 'COMPLETED', completedAt, lockedBy: null, lockExpiresAt: null },
    });
    return result.count === 1;
  });

/**
 * Records a failed attempt.
 *
 * With budget left (`attempts < maxAttempts`) the job returns to PENDING with
 * `runAt` pushed one exponential backoff step past the database's now. Without
 * budget it becomes DEAD — `completedAt` stays null, because the job never
 * completed.
 */
export const failJob = async (
  db: Database,
  jobId: string,
  error: unknown,
  options: FailOptions = {},
): Promise<FailOutcome> =>
  withDomainErrors('BackgroundJob', async () => {
    const job = await db.backgroundJob.findUnique({ where: { id: jobId } });
    if (job === null) {
      return 'not-found';
    }
    if (job.status !== 'RUNNING') {
      return 'not-running';
    }

    const lastError = normalizeJobError(error);

    if (job.attempts >= job.maxAttempts) {
      await db.backgroundJob.updateMany({
        where: { id: jobId, status: 'RUNNING' },
        data: { status: 'DEAD', lastError, lockedBy: null, lockExpiresAt: null },
      });
      return 'dead';
    }

    // The backoff step is anchored to the database's clock inside the UPDATE
    // itself: `runAt = now() + delay`. A skewed or paused worker clock can
    // never pull a retry earlier than the database believes it should run.
    const delayMs = computeBackoffDelayMs(job.attempts, job.backoffBaseMs, options.backoffCapMs);
    const delayed = await db.$executeRaw`
      UPDATE "background_jobs" SET
        "status" = 'PENDING',
        "runAt" = now() + (${delayMs}::bigint * interval '1 millisecond'),
        "lastError" = ${lastError},
        "lockedBy" = NULL,
        "lockExpiresAt" = NULL,
        "updatedAt" = now()
      WHERE "id" = ${jobId} AND "status" = 'RUNNING'
    `;
    return delayed === 1 ? 'retry' : 'not-running';
  });

/**
 * Dead-letters a RUNNING job immediately, skipping any remaining retry budget.
 * The delivery pipeline's dead-letter path (finalize-on-exhaustion) uses this
 * when the failure is known-permanent.
 */
export const markJobDead = async (
  db: Database,
  jobId: string,
  error: unknown,
): Promise<boolean> =>
  withDomainErrors('BackgroundJob', async () => {
    const result = await db.backgroundJob.updateMany({
      where: { id: jobId, status: 'RUNNING' },
      data: {
        status: 'DEAD',
        lastError: normalizeJobError(error),
        lockedBy: null,
        lockExpiresAt: null,
      },
    });
    return result.count === 1;
  });

/**
 * Cancels a PENDING job. A RUNNING job is refused: its processor is already
 * executing and only the processor (or the reaper) may move it. Terminal rows
 * are already past caring.
 */
export const cancelJob = async (db: Database, jobId: string): Promise<boolean> =>
  withDomainErrors('BackgroundJob', async () => {
    const result = await db.backgroundJob.updateMany({
      where: { id: jobId, status: 'PENDING' },
      data: { status: 'CANCELLED', lockedBy: null, lockExpiresAt: null },
    });
    return result.count === 1;
  });

// ---------------------------------------------------------------------------
// Reaping (crash / stall recovery)
// ---------------------------------------------------------------------------

/**
 * Recovers jobs whose lease expired while RUNNING — the worker died or stalled
 * mid-job and never finished.
 *
 * Two conditional statements, each atomic on its own, dead-lettering first:
 * expired jobs with budget left return to PENDING (immediately claimable),
 * expired jobs with an exhausted budget become DEAD. Two concurrent reapers
 * cannot corrupt anything — each UPDATE only matches rows still in RUNNING,
 * so a row is transitioned exactly once no matter how many reapers run.
 */
export const reapExpiredJobs = async (db: Database): Promise<ReapResult> =>
  withDomainErrors('BackgroundJob', async () => {
    const dead = await db.$executeRaw`
      UPDATE "background_jobs" SET
        "status" = 'DEAD',
        "lastError" = COALESCE("lastError", 'lease expired: worker lost the lock before completing'),
        "lockedBy" = NULL,
        "lockExpiresAt" = NULL,
        "updatedAt" = now()
      WHERE "status" = 'RUNNING' AND "lockExpiresAt" < now() AND "attempts" >= "maxAttempts"
    `;
    const reaped = await db.$executeRaw`
      UPDATE "background_jobs" SET
        "status" = 'PENDING',
        "lastError" = COALESCE("lastError", 'lease expired: recovered by reaper'),
        "lockedBy" = NULL,
        "lockExpiresAt" = NULL,
        "runAt" = now(),
        "updatedAt" = now()
      WHERE "status" = 'RUNNING' AND "lockExpiresAt" < now() AND "attempts" < "maxAttempts"
    `;
    return { reaped, dead };
  });

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface PruneTerminalJobsInput {
  /** COMPLETED rows whose completion instant is older than this are deleted. */
  completedOlderThan: Date;
  /** DEAD and CANCELLED rows whose last transition is older than this are deleted. */
  terminalOlderThan: Date;
}

export interface PruneTerminalJobsResult {
  completed: number;
  terminal: number;
}

/**
 * Prunes terminal `BackgroundJob` rows — the durable queue's retention.
 *
 * Completed work ages out after a day; dead and cancelled rows are kept a
 * week for forensics. PENDING and RUNNING rows are never touched: an age cut-off can
 * only match terminal statuses, so an in-flight or waiting job is structurally
 * safe. Every delete is a single bounded statement and can be re-run freely.
 */
export const pruneTerminalJobs = async (
  db: Database,
  { completedOlderThan, terminalOlderThan }: PruneTerminalJobsInput,
): Promise<PruneTerminalJobsResult> =>
  withDomainErrors('BackgroundJob', async () => {
    const completed = await db.backgroundJob.deleteMany({
      where: { status: 'COMPLETED', completedAt: { lt: completedOlderThan } },
    });
    const terminal = await db.backgroundJob.deleteMany({
      where: { status: { in: ['DEAD', 'CANCELLED'] }, updatedAt: { lt: terminalOlderThan } },
    });
    return { completed: completed.count, terminal: terminal.count };
  });

// ---------------------------------------------------------------------------
// Inspection (observability)
// ---------------------------------------------------------------------------

/** Row counts per queue and status — the queue-depth gauges' source. */
export const inspectQueueDepth = async (db: Database): Promise<QueueDepthRow[]> => {
  const rows = await db.backgroundJob.groupBy({
    by: ['queue', 'status'],
    _count: { _all: true },
  });
  return rows.map((row) => ({ queue: row.queue, status: row.status, count: row._count._all }));
};

/** The oldest still-pending job, for the "how far behind are we" gauge. */
export const oldestPendingJob = async (
  db: Database,
  queue?: string,
): Promise<{ id: string; runAt: Date } | null> =>
  db.backgroundJob.findFirst({
    where: { status: 'PENDING', ...(queue !== undefined ? { queue } : {}) },
    orderBy: [{ runAt: 'asc' }, { id: 'asc' }],
    select: { id: true, runAt: true },
  });

/**
 * How overdue the most due schedule is, in seconds (0 when nothing is waiting).
 * A persistently positive value means the ticker is not keeping up — or that no
 * worker is ticking at all.
 */
export const scheduleLagSeconds = async (db: Database): Promise<number> => {
  const rows = await db.$queryRaw<{ lag: number }[]>`
    SELECT COALESCE(
      GREATEST(EXTRACT(EPOCH FROM (now() - MIN("nextRunAt"))), 0),
      0
    )::int AS "lag"
    FROM "job_schedules"
  `;
  return rows[0]?.lag ?? 0;
};

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export interface UpsertScheduleInput {
  scheduleKey: string;
  queue: string;
  name: string;
  payload: Prisma.InputJsonValue;
  everySeconds: number;
  /**
   * The next fire. Applied on create *and* on update: re-registering a
   * schedule re-anchors its cadence ("replaces rather than stacks"), so boot
   * re-registration is idempotent. Callers pass their injected clock's
   * instant.
   */
  nextRunAt: Date;
}

/** Idempotently registers or refreshes a repeatable schedule. */
export const upsertJobSchedule = async (db: Database, input: UpsertScheduleInput) =>
  withDomainErrors('JobSchedule', () =>
    db.jobSchedule.upsert({
      where: { scheduleKey: input.scheduleKey },
      create: {
        scheduleKey: input.scheduleKey,
        queue: input.queue,
        name: input.name,
        payload: input.payload,
        everySeconds: input.everySeconds,
        nextRunAt: input.nextRunAt,
      },
      update: {
        queue: input.queue,
        name: input.name,
        payload: input.payload,
        everySeconds: input.everySeconds,
        nextRunAt: input.nextRunAt,
      },
    }),
  );

/** Removes a schedule (e.g. a calendar connection was disconnected). */
export const deleteJobSchedule = async (db: Database, scheduleKey: string): Promise<boolean> =>
  withDomainErrors('JobSchedule', async () => {
    const result = await db.jobSchedule.deleteMany({ where: { scheduleKey } });
    return result.count === 1;
  });

export const listJobSchedules = async (db: Database) =>
  db.jobSchedule.findMany({ orderBy: { scheduleKey: 'asc' } });

/**
 * Claims all due schedules, advancing each one full interval past *now* in the
 * same statement that claims it.
 *
 * Fleet-safe: the inner `FOR UPDATE SKIP LOCKED` hands each due row to exactly
 * one ticker, so two tickers can never materialise the same occurrence. A run
 * missed while nothing was ticking is skipped, not replayed — `nextRunAt`
 * becomes `now() + everySeconds`, never a burst of catch-up fires.
 *
 * The caller materialises one job per returned schedule; if that enqueue fails
 * the occurrence is lost and simply waits for the next interval (the schedules
 * drive periodic sweeps, where skipping beats double-firing).
 */
export const claimDueSchedules = async (
  db: Database,
  { limit }: { limit: number },
): Promise<Prisma.JobScheduleGetPayload<object>[]> =>
  withDomainErrors('JobSchedule', async () => {
    const rows = await db.$queryRaw<Prisma.JobScheduleGetPayload<object>[]>`
      UPDATE "job_schedules" SET
        "nextRunAt" = now() + ("everySeconds"::int * interval '1 second'),
        "lastRunAt" = now(),
        "updatedAt" = now()
      WHERE "id" IN (
        SELECT "id" FROM "job_schedules"
        WHERE "nextRunAt" <= now()
        ORDER BY "nextRunAt" ASC, "id" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *;
    `;
    return rows;
  });
