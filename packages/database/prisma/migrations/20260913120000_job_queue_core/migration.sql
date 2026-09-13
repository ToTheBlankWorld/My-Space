-- Stage 2 (Redis removal migration) — PostgreSQL job queue core.
-- ---------------------------------------------------------------
-- Additive only. Introduces the durable job store (`background_jobs`), the
-- repeatable schedule store (`job_schedules`), and the calendar-connection
-- sync lease columns that will replace the Redis `SET NX EX` lock. The
-- existing BullMQ system keeps running unchanged until the cutover stage;
-- nothing existing is modified beyond the two added columns.

-- 1. Job lifecycle vocabulary. Mirrors `JOB_STATUSES` in `@space/types`
--    (see the enum-parity test).
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'DEAD', 'CANCELLED');

-- 2. Durable background jobs. The row is the job: claimed atomically with
--    UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED), retried with
--    exponential backoff through `runAt`, recovered by the reaper through the
--    `lockExpiresAt` lease.
CREATE TABLE "background_jobs" (
  "id" TEXT NOT NULL,
  "queue" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
  "priority" INTEGER NOT NULL DEFAULT 100,
  "runAt" TIMESTAMPTZ(3) NOT NULL,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "backoffBaseMs" INTEGER NOT NULL DEFAULT 10000,
  "lastError" TEXT,
  "dedupeKey" TEXT,
  "lockedBy" TEXT,
  "lockExpiresAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3),

  CONSTRAINT "background_jobs_pkey" PRIMARY KEY ("id")
);

-- Deduplication / coalescing identity. Nulls (always-new jobs) are never
-- unique-conflicted, so the index costs them nothing.
CREATE UNIQUE INDEX "background_jobs_dedupeKey_key" ON "background_jobs"("dedupeKey");

-- The claim query: filter by status, queue and due-ness; the ORDER BY
-- (priority, runAt, id) runs over the small filtered set.
CREATE INDEX "background_jobs_status_queue_runAt_idx"
  ON "background_jobs"("status", "queue", "runAt");

-- The reaper: expired leases are by definition still RUNNING, so a partial
-- index keeps it tiny and self-maintaining.
CREATE INDEX "background_jobs_lockExpiresAt_idx" ON "background_jobs"("lockExpiresAt")
  WHERE "status" = 'RUNNING' AND "lockExpiresAt" IS NOT NULL;

-- Retention: terminal rows are pruned by their last transition.
CREATE INDEX "background_jobs_terminal_updatedAt_idx" ON "background_jobs"("updatedAt")
  WHERE "status" IN ('COMPLETED', 'DEAD', 'CANCELLED');

-- 3. Repeatable schedules. One row per schedule under a unique key; the ticker
--    claims due rows with SKIP LOCKED and advances `nextRunAt` in the same
--    statement, which makes duplicate occurrences impossible across a fleet.
CREATE TABLE "job_schedules" (
  "id" TEXT NOT NULL,
  "scheduleKey" TEXT NOT NULL,
  "queue" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "everySeconds" INTEGER NOT NULL,
  "nextRunAt" TIMESTAMPTZ(3) NOT NULL,
  "lastRunAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "job_schedules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "job_schedules_scheduleKey_key" ON "job_schedules"("scheduleKey");

-- The ticker's only query.
CREATE INDEX "job_schedules_nextRunAt_idx" ON "job_schedules"("nextRunAt");

-- 4. Calendar connection sync lease — the PostgreSQL replacement for the
--    per-connection Redis `SET NX EX` lock. `syncLeaseOwner` is a random
--    per-attempt token and `syncLeaseUntil` the TTL; acquire and release are
--    single atomic UPDATEs using the database clock.
ALTER TABLE "calendar_connections" ADD COLUMN "syncLeaseUntil" TIMESTAMPTZ(3);
ALTER TABLE "calendar_connections" ADD COLUMN "syncLeaseOwner" TEXT;
