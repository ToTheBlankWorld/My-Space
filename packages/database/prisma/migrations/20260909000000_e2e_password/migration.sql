-- AlterTable
-- Nullable bcrypt hash written only by the deterministic end-to-end test
-- sign-in. Production never sets it: email/password is disabled unless
-- E2E_AUTH_ENABLED is set, and the auth environment schema refuses that flag
-- when NODE_ENV=production.
ALTER TABLE "users" ADD COLUMN "password" TEXT;