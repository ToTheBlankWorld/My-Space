import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import type { DatabaseClient } from '../../client';
import * as jobs from '../../repositories/jobs';
import { cleanupTestData, createTestClient, describeIntegration } from './setup';

/**
 * Queue behaviour only a real database can prove: the SKIP LOCKED claim's
 * atomicity under concurrency, lease reaping, retry/backoff persistence,
 * dedupe/coalescing transitions, and fleet-safe schedule ticking.
 */

const QUEUE = 'itest-jobs';

/** Node-clock tolerance when asserting database-clock-derived timestamps. */
const CLOCK_TOLERANCE_MS = 2_000;

describeIntegration('background jobs', () => {
  let db: DatabaseClient;
  let second: DatabaseClient;

  const enqueue = async (overrides: Partial<jobs.EnqueueJobInput> = {}) =>
    jobs.enqueueJob(db, {
      queue: QUEUE,
      name: 'work',
      payload: { n: 1 },
      backoffBaseMs: 1_000,
      runAt: new Date(Date.now() - 60_000),
      ...overrides,
    });

  beforeAll(() => {
    db = createTestClient();
    // A second pool, so concurrent claims/reapers are genuinely concurrent.
    second = createTestClient();
  });

  beforeEach(async () => {
    await db.backgroundJob.deleteMany({});
    await db.jobSchedule.deleteMany({});
  });

  afterAll(async () => {
    await db.backgroundJob.deleteMany({});
    await db.jobSchedule.deleteMany({});
    await cleanupTestData(db);
    await db.$disconnect();
    await second.$disconnect();
  });

  // ---------------------------------------------------------------- claim

  it('claims only due pending jobs, in priority then runAt order, with a fresh lease', async () => {
    const overdue = await enqueue({ priority: 100, runAt: new Date(Date.now() - 60_000) });
    const urgent = await enqueue({ priority: 0, runAt: new Date(Date.now() - 30_000) });
    await enqueue({ runAt: new Date(Date.now() + 60_000) }); // not due yet

    const claimed = await jobs.claimJobs(db, {
      queue: QUEUE,
      workerId: 'w1',
      leaseSeconds: 90,
      limit: 10,
    });

    expect(claimed.map((job) => job.id)).toEqual([urgent.id, overdue.id]);
    expect(claimed[0]).toMatchObject({ status: 'RUNNING', attempts: 1, lockedBy: 'w1' });
    // Lease arithmetic happened in the database, against its own clock.
    expect(claimed[0]!.lockExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(claimed[0]!.lockExpiresAt!.getTime()).toBeLessThan(Date.now() + 120_000);
  });

  it('never hands the same job to two concurrent claimers', async () => {
    const seeded = await Promise.all(
      Array.from({ length: 6 }, () => enqueue()),
    );

    const [first, secondBatch] = await Promise.all([
      jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 10 }),
      jobs.claimJobs(second, { queue: QUEUE, workerId: 'w2', leaseSeconds: 90, limit: 10 }),
    ]);

    const all = [...first, ...secondBatch];
    const ids = all.map((job) => job.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(seeded.map((job) => job.id)));
    expect(ids.filter((id) => first.some((job) => job.id === id) && secondBatch.some((job) => job.id === id))).toEqual([]);
  });

  // ----------------------------------------------------------------- reaper

  it('returns an expired RUNNING job to PENDING while budget remains', async () => {
    const job = await enqueue();
    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 1 });
    await db.backgroundJob.update({
      where: { id: job.id },
      data: { lockExpiresAt: new Date(Date.now() - 1_000) },
    });

    const result = await jobs.reapExpiredJobs(db);

    expect(result).toMatchObject({ reaped: 1, dead: 0 });
    const after = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(after).toMatchObject({ status: 'PENDING', lockedBy: null, lockExpiresAt: null });
  });

  it('dead-letters an expired RUNNING job whose budget is exhausted', async () => {
    const job = await enqueue({ maxAttempts: 2 });
    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 1 });
    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 1 });
    await db.backgroundJob.update({
      where: { id: job.id },
      data: { lockExpiresAt: new Date(Date.now() - 1_000) },
    });

    const result = await jobs.reapExpiredJobs(db);

    expect(result).toMatchObject({ reaped: 0, dead: 1 });
    const after = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(after?.status).toBe('DEAD');
    expect(after?.completedAt).toBeNull();
    expect(after?.lastError).toContain('lease expired');
  });

  it('leaves a non-expired RUNNING job untouched', async () => {
    const job = await enqueue();
    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 1 });

    const result = await jobs.reapExpiredJobs(db);

    expect(result).toMatchObject({ reaped: 0, dead: 0 });
    const after = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(after).toMatchObject({ status: 'RUNNING', lockedBy: 'w1' });
  });

  it('is safe when two reapers race: the row transitions exactly once', async () => {
    const job = await enqueue();
    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 1 });
    await db.backgroundJob.update({
      where: { id: job.id },
      data: { lockExpiresAt: new Date(Date.now() - 1_000) },
    });

    const [a, b] = await Promise.all([jobs.reapExpiredJobs(db), jobs.reapExpiredJobs(second)]);

    // Exactly one reaper saw the row; both agree the ledger balances.
    expect(a.reaped + b.reaped).toBe(1);
    expect(a.dead + b.dead).toBe(0);
    expect(await db.backgroundJob.count({ where: { id: job.id, status: 'PENDING' } })).toBe(1);
  });

  // ---------------------------------------------------------- retry / dead

  it('reschedules a failed attempt one backoff step out and records the error', async () => {
    const job = await enqueue({ backoffBaseMs: 30_000 });
    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 1 });
    const before = Date.now();

    const outcome = await jobs.failJob(db, job.id, new Error('provider unavailable'));

    expect(outcome).toBe('retry');
    const after = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(after).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lockedBy: null,
      lockExpiresAt: null,
      lastError: 'Error: provider unavailable',
    });
    // First failure waits one base interval (30s), anchored near the database's now.
    expect(after!.runAt.getTime()).toBeGreaterThanOrEqual(before + 30_000 - CLOCK_TOLERANCE_MS);
    expect(after!.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 30_000 + CLOCK_TOLERANCE_MS);
  });

  it('doubles the backoff after the second failure', async () => {
    const job = await enqueue({ backoffBaseMs: 10_000 });
    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 1 });
    await jobs.failJob(db, job.id, new Error('first'));
    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 1 });
    const before = Date.now();

    await jobs.failJob(db, job.id, new Error('second'));

    const after = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(after!.runAt.getTime()).toBeGreaterThanOrEqual(before + 20_000 - CLOCK_TOLERANCE_MS);
  });

  it('moves a RUNNING job to DEAD when the retry budget is exhausted, without completedAt', async () => {
    const job = await enqueue({ maxAttempts: 1 });
    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 1 });

    const outcome = await jobs.failJob(db, job.id, 'permanent-looking');

    expect(outcome).toBe('dead');
    const after = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(after).toMatchObject({
      status: 'DEAD',
      completedAt: null,
      lastError: 'permanent-looking',
      lockedBy: null,
    });
  });

  it('completes a RUNNING job and refuses to complete a job this worker no longer holds', async () => {
    const job = await enqueue();
    expect(await jobs.completeJob(db, job.id, new Date())).toBe(false); // still PENDING

    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 1 });
    expect(await jobs.completeJob(db, job.id, new Date())).toBe(true);
    const after = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(after?.status).toBe('COMPLETED');
    expect(after?.completedAt).not.toBeNull();
    expect(await jobs.completeJob(db, job.id, new Date())).toBe(false); // already terminal
  });

  it('cancels a PENDING job but refuses to cancel a RUNNING one', async () => {
    const pending = await enqueue();
    expect(await jobs.cancelJob(db, pending.id)).toBe(true);
    expect(await jobs.cancelJob(db, pending.id)).toBe(false); // already CANCELLED

    const running = await enqueue();
    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 1 });
    expect(await jobs.cancelJob(db, running.id)).toBe(false);
    expect((await db.backgroundJob.findUnique({ where: { id: running.id } }))?.status).toBe('RUNNING');
  });

  // -------------------------------------------------------------- dedupe

  it('dedupes insert-if-absent: a PENDING duplicate is suppressed untouched', async () => {
    const first = await jobs.enqueueDedupedJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'delivery',
      payload: { v: 1 },
      dedupeKey: 'itest:dedupe',
    });
    expect(first.outcome).toBe('created');

    const second = await jobs.enqueueDedupedJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'delivery',
      payload: { v: 2 },
      dedupeKey: 'itest:dedupe',
    });

    expect(second.outcome).toBe('duplicate');
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.payload).toEqual({ v: 1 });
    expect(await db.backgroundJob.count({ where: { dedupeKey: 'itest:dedupe' } })).toBe(1);
  });

  it('dedupes against a RUNNING job, and against a terminal one unless rearm is requested', async () => {
    const created = await jobs.enqueueDedupedJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'delivery',
      payload: { v: 1 },
      dedupeKey: 'itest:dedupe-run',
    });
    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 1 });

    const whileRunning = await jobs.enqueueDedupedJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'delivery',
      payload: { v: 2 },
      dedupeKey: 'itest:dedupe-run',
    });
    expect(whileRunning.outcome).toBe('duplicate');
    expect(whileRunning.job.status).toBe('RUNNING');

    await jobs.completeJob(db, created.job.id, new Date());
    const whileCompleted = await jobs.enqueueDedupedJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'delivery',
      payload: { v: 3 },
      dedupeKey: 'itest:dedupe-run',
    });
    expect(whileCompleted.outcome).toBe('duplicate');
    expect(whileCompleted.job.status).toBe('COMPLETED');

    const rearmed = await jobs.enqueueDedupedJob(
      db,
      { queue: QUEUE, name: 'delivery', payload: { v: 4 }, dedupeKey: 'itest:dedupe-run', runAt: new Date() },
      { rearm: true },
    );
    expect(rearmed.outcome).toBe('rearmed');
    expect(rearmed.job).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      completedAt: null,
    });
    expect(rearmed.job.payload).toEqual({ v: 4 });
  });

  it('dedupes against a DEAD job the same way', async () => {
    const created = await jobs.enqueueDedupedJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'work',
      payload: { v: 1 },
      dedupeKey: 'itest:dedupe-dead',
      maxAttempts: 1,
    });
    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 1 });
    await jobs.failJob(db, created.job.id, 'nope');
    expect((await db.backgroundJob.findUnique({ where: { id: created.job.id } }))?.status).toBe('DEAD');

    const suppressed = await jobs.enqueueDedupedJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'work',
      payload: { v: 2 },
      dedupeKey: 'itest:dedupe-dead',
    });
    expect(suppressed.outcome).toBe('duplicate');
    expect(suppressed.job.status).toBe('DEAD');

    const rearmed = await jobs.enqueueDedupedJob(
      db,
      { queue: QUEUE, name: 'work', payload: { v: 2 }, dedupeKey: 'itest:dedupe-dead', runAt: new Date() },
      { rearm: true },
    );
    expect(rearmed.outcome).toBe('rearmed');
    expect(rearmed.job.status).toBe('PENDING');
  });

  // ------------------------------------------------------------ coalesce

  it('coalesces a PENDING job with the newer payload and a fresh budget', async () => {
    const created = await jobs.coalesceJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'autonomous-replan',
      payload: { version: 1 },
      dedupeKey: 'itest:replan:space1',
    });
    expect(created.outcome).toBe('created');
    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 1 });
    await jobs.failJob(db, created.job.id, 'first try'); // attempts: 1, back to PENDING

    const coalesced = await jobs.coalesceJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'autonomous-replan',
      payload: { version: 2 },
      dedupeKey: 'itest:replan:space1',
    });

    expect(coalesced.outcome).toBe('coalesced');
    expect(coalesced.job).toMatchObject({ status: 'PENDING', attempts: 0, lastError: null });
    expect(coalesced.job.payload).toEqual({ version: 2 });
  });

  it('never overwrites a RUNNING job when coalescing', async () => {
    await jobs.coalesceJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'autonomous-replan',
      payload: { version: 1 },
      dedupeKey: 'itest:replan:space2',
    });
    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 1 });

    const coalesced = await jobs.coalesceJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'autonomous-replan',
      payload: { version: 2 },
      dedupeKey: 'itest:replan:space2',
    });

    expect(coalesced.outcome).toBe('suppressed-running');
    expect(coalesced.job.payload).toEqual({ version: 1 });
    expect(coalesced.job.status).toBe('RUNNING');
  });

  it('never silently resurrects COMPLETED, DEAD or CANCELLED jobs when coalescing', async () => {
    const completed = await jobs.coalesceJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'work',
      payload: { v: 1 },
      dedupeKey: 'itest:coalesce-done',
    });
    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 1 });
    await jobs.completeJob(db, completed.job.id, new Date());

    const suppressed = await jobs.coalesceJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'work',
      payload: { v: 2 },
      dedupeKey: 'itest:coalesce-done',
    });
    expect(suppressed.outcome).toBe('suppressed-terminal');
    expect(suppressed.job.status).toBe('COMPLETED');

    const dead = await jobs.coalesceJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'work',
      payload: { v: 1 },
      dedupeKey: 'itest:coalesce-dead',
    });
    await db.backgroundJob.update({ where: { id: dead.job.id }, data: { status: 'DEAD' } });
    const deadCoalesce = await jobs.coalesceJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'work',
      payload: { v: 2 },
      dedupeKey: 'itest:coalesce-dead',
    });
    expect(deadCoalesce.outcome).toBe('suppressed-terminal');
    expect(deadCoalesce.job.status).toBe('DEAD');

    const cancelled = await jobs.coalesceJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'work',
      payload: { v: 1 },
      dedupeKey: 'itest:coalesce-cancelled',
    });
    await jobs.cancelJob(db, cancelled.job.id);
    const cancelledCoalesce = await jobs.coalesceJob(db, {
      queue: QUEUE,
      runAt: new Date(),
      name: 'work',
      payload: { v: 2 },
      dedupeKey: 'itest:coalesce-cancelled',
    });
    expect(cancelledCoalesce.outcome).toBe('suppressed-terminal');
    expect(cancelledCoalesce.job.status).toBe('CANCELLED');

    // With `rearm` the caller explicitly accepts the resurrection.
    const rearmed = await jobs.coalesceJob(
      db,
      { queue: QUEUE, name: 'work', payload: { v: 3 }, dedupeKey: 'itest:coalesce-cancelled', runAt: new Date() },
      { rearm: true },
    );
    expect(rearmed.outcome).toBe('rearmed');
    expect(rearmed.job.status).toBe('PENDING');
  });

  // ----------------------------------------------------------- schedules

  it('upserts schedules idempotently, re-anchoring the cadence on re-registration', async () => {
    const firstRun = new Date(Date.now() + 300_000);
    await jobs.upsertJobSchedule(db, {
      scheduleKey: 'itest:sweep',
      queue: QUEUE,
      name: 'sweep',
      payload: { kind: 'sweep' },
      everySeconds: 300,
      nextRunAt: firstRun,
    });

    // Re-registering at boot re-anchors the cadence (replaces, never stacks) —
    // so a rolling deploy never stacks schedules.
    const reAnchored = new Date(Date.now() + 600_000);
    await jobs.upsertJobSchedule(db, {
      scheduleKey: 'itest:sweep',
      queue: QUEUE,
      name: 'sweep',
      payload: { kind: 'sweep' },
      everySeconds: 300,
      nextRunAt: reAnchored,
    });

    const rows = await jobs.listJobSchedules(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scheduleKey: 'itest:sweep', everySeconds: 300 });
    expect(rows[0]!.nextRunAt.getTime()).toBe(reAnchored.getTime());
  });

  it('claims due schedules and advances them one full interval, skipping missed runs', async () => {
    await jobs.upsertJobSchedule(db, {
      scheduleKey: 'itest:review',
      queue: QUEUE,
      name: 'review',
      payload: {},
      everySeconds: 600,
      nextRunAt: new Date(Date.now() - 60_000), // long overdue
    });
    const before = Date.now();

    const claimed = await jobs.claimDueSchedules(db, { limit: 10 });

    expect(claimed).toHaveLength(1);
    const anyInstant = expect.any(Date) as unknown as Date;
    expect(claimed[0]).toMatchObject({ scheduleKey: 'itest:review', lastRunAt: anyInstant });
    // nextRunAt is one interval from now, not a burst of catch-up fires.
    expect(claimed[0]!.nextRunAt.getTime()).toBeGreaterThanOrEqual(before + 600_000);
    expect(claimed[0]!.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now() + 600_000 + CLOCK_TOLERANCE_MS);

    // Already advanced: an immediate second claim finds nothing due.
    expect(await jobs.claimDueSchedules(db, { limit: 10 })).toHaveLength(0);
  });

  it('is fleet-safe: two concurrent tickers never materialise the same occurrence', async () => {
    await Promise.all(
      ['itest:s1', 'itest:s2', 'itest:s3'].map((scheduleKey) =>
        jobs.upsertJobSchedule(db, {
          scheduleKey,
          queue: QUEUE,
          name: 'tick',
          payload: {},
          everySeconds: 600,
          nextRunAt: new Date(Date.now() - 1_000),
        }),
      ),
    );

    const [first, secondBatch] = await Promise.all([
      jobs.claimDueSchedules(db, { limit: 10 }),
      jobs.claimDueSchedules(second, { limit: 10 }),
    ]);

    const ids = [...first, ...secondBatch].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set([...first, ...secondBatch].map((row) => row.scheduleKey))).toEqual(
      new Set(['itest:s1', 'itest:s2', 'itest:s3']),
    );
  });

  // ----------------------------------------------------------- retention

  it('prunes only terminal job rows, never pending or running ones', async () => {
    // A COMPLETED row whose completion instant is 3 days old (past the 1-day cut).
    const completed = await enqueue({ runAt: new Date() });
    await jobs.claimJobs(db, { queue: QUEUE, workerId: 'w1', leaseSeconds: 90, limit: 10 });
    await jobs.completeJob(db, completed.id, new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));

    // A DEAD row whose last transition is 9 days old (past the 7-day cut).
    // Raw update so Prisma's @updatedAt does not overwrite the aged timestamp.
    const dead = await enqueue({ runAt: new Date() });
    await db.$executeRaw`
      UPDATE "background_jobs" SET "status" = 'DEAD', "updatedAt" = now() - interval '9 days'
      WHERE "id" = ${dead.id}
    `;

    // Survivors: one PENDING, one RUNNING (fresh lease, not reaped in this test).
    const pending = await enqueue({ runAt: new Date() });
    const running = await enqueue({ runAt: new Date() });
    await jobs.claimJobs(second, { queue: QUEUE, workerId: 'w2', leaseSeconds: 3600, limit: 1 });
    // The claim above took whichever was first; force the other to RUNNING too.
    await db.$executeRaw`
      UPDATE "background_jobs" SET "status" = 'RUNNING', "lockedBy" = 'w2',
        "lockExpiresAt" = now() + interval '1 hour'
      WHERE "id" IN (${pending.id}, ${running.id})
    `;

    const result = await jobs.pruneTerminalJobs(db, {
      completedOlderThan: new Date(Date.now() - 24 * 60 * 60 * 1000),
      terminalOlderThan: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    });

    expect(result.completed).toBe(1);
    expect(result.terminal).toBe(1);
    // In-flight and waiting rows survive every prune.
    for (const id of [pending.id, running.id]) {
      const row = await db.backgroundJob.findUnique({ where: { id } });
      expect(row?.status).toBe('RUNNING');
    }
  });

  // -------------------------------------------------------- inspection

  it('reports queue depth, the oldest pending job, and schedule lag', async () => {
    const a = await enqueue({ runAt: new Date(Date.now() - 120_000) });
    await enqueue({ runAt: new Date(Date.now() - 60_000) });
    await jobs.upsertJobSchedule(db, {
      scheduleKey: 'itest:lag',
      queue: QUEUE,
      name: 'tick',
      payload: {},
      everySeconds: 60,
      nextRunAt: new Date(Date.now() - 30_000),
    });

    const depth = await jobs.inspectQueueDepth(db);
    expect(depth).toContainEqual({ queue: QUEUE, status: 'PENDING', count: 2 });

    const oldest = await jobs.oldestPendingJob(db, QUEUE);
    expect(oldest?.id).toBe(a.id);

    const lag = await jobs.scheduleLagSeconds(db);
    expect(lag).toBeGreaterThanOrEqual(30);
  });
});
