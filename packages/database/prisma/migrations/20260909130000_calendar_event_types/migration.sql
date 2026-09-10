-- AlterEnum
-- Calendar lifecycle events for the audit trail. Postgres 12+ supports adding
-- several enum values in one migration; targets the same db the app uses.
ALTER TYPE "EventType" ADD VALUE 'CALENDAR_CONNECTED';
ALTER TYPE "EventType" ADD VALUE 'CALENDAR_DISCONNECTED';
ALTER TYPE "EventType" ADD VALUE 'CALENDAR_SYNCED';
ALTER TYPE "EventType" ADD VALUE 'CALENDAR_SYNC_FAILED';

-- AlterEnum
ALTER TYPE "AggregateType" ADD VALUE 'CALENDAR_CONNECTION';