-- Stage 11 — production hardening.
-- ---------------------------------------------------------------
-- 1. `outbox_cursors.updatedAt` was created as TIMESTAMP(3) (no time zone) but
--    the Prisma schema declares it as Timestamptz(3). Align the column so the
--    database matches the schema and `prisma migrate dev` reports no drift.
ALTER TABLE "outbox_cursors" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3);

-- 2. Retention indexes. The Stage 11 maintenance worker prunes audit and
--    notification tables by a global age cut-off (not per-user), so each of
--    these tables needs an index that makes a global `WHERE occurredAt < X`
--    / `WHERE createdAt < X` delete cheap instead of a full scan.
CREATE INDEX "event_logs_occurredAt_idx" ON "event_logs"("occurredAt");
CREATE INDEX "agent_actions_occurredAt_idx" ON "agent_actions"("occurredAt");
CREATE INDEX "notifications_createdAt_idx" ON "notifications"("createdAt");
CREATE INDEX "email_logs_createdAt_idx" ON "email_logs"("createdAt");
-- Calendar-event tombstones are pruned only when unreferenced by a Space; the
-- partial predicate mirrors that query so the scan touches only live tombstones.
CREATE INDEX "calendar_events_deletedAt_idx" ON "calendar_events"("deletedAt")
  WHERE "deletedAt" IS NOT NULL;