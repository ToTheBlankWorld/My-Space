-- Stage 3: authentication.
--
-- Three new tables owned by `@space/auth`, two new columns on `users`, and a
-- rename of the autonomy vocabulary. No existing user content is touched.
--
-- Reversibility: every statement here except the `emailVerifiedAt` drop is
-- reversible. That drop is preceded by a backfill so no information is lost —
-- the boolean carries forward whether the address was verified. Rolling back
-- would restore the column but not the original timestamps, which is why the
-- backfill is a separate, auditable statement rather than an implicit cast.

-- ---------------------------------------------------------------------------
-- Autonomy vocabulary
--
-- `RENAME VALUE` rather than Prisma's default create-new-type-and-cast: renaming
-- is instantaneous, rewrites no rows, and cannot fail on data that still uses an
-- old label. The three values map one-to-one onto the new names.
-- ---------------------------------------------------------------------------
ALTER TYPE "AutonomyLevel" RENAME VALUE 'MANUAL' TO 'SUGGEST_ONLY';
ALTER TYPE "AutonomyLevel" RENAME VALUE 'ASSISTED' TO 'ASK_BEFORE_CHANGING';
ALTER TYPE "AutonomyLevel" RENAME VALUE 'AUTOMATIC' TO 'AUTOMATICALLY_MANAGE';

-- Re-state the default so it is stored against the renamed label explicitly.
ALTER TABLE "planning_preferences"
  ALTER COLUMN "autonomyLevel" SET DEFAULT 'ASK_BEFORE_CHANGING';

-- ---------------------------------------------------------------------------
-- users
--
-- The authentication library models email verification as a boolean. The
-- timestamp it replaces recorded the same fact with an extra dimension nothing
-- read, so it is backfilled and dropped rather than kept as a second source of
-- truth.
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false;

UPDATE "users" SET "emailVerified" = true WHERE "emailVerifiedAt" IS NOT NULL;

ALTER TABLE "users" DROP COLUMN "emailVerifiedAt";

-- Null until onboarding completes. The application shell reads exactly this.
ALTER TABLE "users" ADD COLUMN "onboardingCompletedAt" TIMESTAMPTZ(3);

-- ---------------------------------------------------------------------------
-- accounts: provider identities
--
-- Token columns hold AEAD ciphertext, never plaintext. The database never sees
-- a usable credential.
-- ---------------------------------------------------------------------------
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(3),
    "refreshTokenExpiresAt" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- sessions: server-side, revocable
-- ---------------------------------------------------------------------------
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- verifications: short-lived values, including OAuth state
-- ---------------------------------------------------------------------------
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- One row per provider identity: a returning sign-in updates it in place.
CREATE UNIQUE INDEX "accounts_providerId_accountId_key" ON "accounts"("providerId", "accountId");

-- Every authenticated request is a lookup by this token.
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- "Sign out everywhere".
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- The sweep that deletes expired sessions.
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");
CREATE INDEX "verifications_expiresAt_idx" ON "verifications"("expiresAt");

-- ---------------------------------------------------------------------------
-- Foreign keys
--
-- Both cascade: an account's provider identities and sessions have no meaning
-- once the account is gone, and leaving an `accounts` row behind would let the
-- same Google identity silently resurrect a deleted user on next sign-in.
-- ---------------------------------------------------------------------------
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
