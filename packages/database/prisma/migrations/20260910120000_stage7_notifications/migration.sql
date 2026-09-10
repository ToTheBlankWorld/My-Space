-- Stage 7 — Notification Engine + Outbox + Reminder Dispatcher.
-- ---------------------------------------------------------------
-- 1. New EventType values for the notification pipeline. PostgreSQL cannot add
--    enum values inside a transaction, so these run outside one (same pattern
--    as the planning events migration).
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'NOTIFICATION_CREATED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'NOTIFICATION_QUEUED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'NOTIFICATION_FAILED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'REMINDER_SKIPPED';

-- 2. Notifications carry a stable, server-generated idempotency key and an
--    optional safe in-app deep link. Unique so redelivered outbox batches or
--    concurrent producers cannot create the same notification twice.
ALTER TABLE "notifications" ADD COLUMN "deliveryKey" TEXT;
ALTER TABLE "notifications" ADD COLUMN "linkUrl" TEXT;
CREATE UNIQUE INDEX "notifications_deliveryKey_key" ON "notifications"("deliveryKey");

-- 3. Email logs link back to the notification that produced the attempt, and
--    carry the bounded structured data the template renders. The link is "safe
--    metadata" only: delivery records live in this table, never on the
--    notification row.
ALTER TABLE "email_logs" ADD COLUMN "notificationId" TEXT;
ALTER TABLE "email_logs" ADD COLUMN "data" JSONB;
CREATE INDEX "email_logs_notificationId_idx" ON "email_logs"("notificationId");
ALTER TABLE "email_logs"
  ADD CONSTRAINT "email_logs_notificationId_fkey" FOREIGN KEY ("notificationId")
  REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Durable cursors for transactional outbox consumers (one row per consumer).
CREATE TABLE "outbox_cursors" (
  "id" TEXT NOT NULL,
  "processorName" TEXT NOT NULL,
  "lastSequence" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "outbox_cursors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "outbox_cursors_processorName_key" ON "outbox_cursors"("processorName");