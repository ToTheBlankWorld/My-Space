-- AlterTable
-- Encrypted Google Calendar credentials for a CalendarConnection. The token
-- columns hold AEAD ciphertext (`spc.v1.<keyId>.<nonce>.<ciphertext>.<tag>`),
-- never plaintext; they are encrypted with the same keyring @space/auth uses,
-- with the `calendar.accessToken` / `calendar.refreshToken` purposes bound into
-- the authenticated data.
ALTER TABLE "calendar_connections" ADD COLUMN     "accessToken" TEXT,
ADD COLUMN     "accessTokenExpiresAt" TIMESTAMPTZ(3),
ADD COLUMN     "refreshToken" TEXT;

-- AlterTable
-- Recurrence metadata preserved from the provider so the future Conflict Engine
-- can expand series without re-querying Google. `recurringEventId` is the
-- provider id of the series master; `originalStartAt` is the instance's
-- original start time (both are returned by ordinary incremental syncs).
ALTER TABLE "calendar_events" ADD COLUMN     "originalStartAt" TIMESTAMPTZ(3),
ADD COLUMN     "recurringEventId" TEXT;

-- CreateIndex
CREATE INDEX "calendar_events_userId_recurringEventId_idx" ON "calendar_events"("userId", "recurringEventId");