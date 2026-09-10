-- AlterEnum
-- Planning pass lifecycle events for the audit trail (Stage 5). PostgreSQL
-- cannot add values to an enum in a transaction, so this runs outside one.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'PLANNING_STARTED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'PLANNING_COMPLETED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'PLANNING_FAILED';