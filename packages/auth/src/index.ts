/**
 * `@space/auth` — identity, sessions and credential protection.
 *
 * ## Boundary
 *
 * Server-only, like `@space/database`. It is reached from the web application
 * through `apps/web/src/server/auth.ts`, which imports `server-only` so that a
 * client import fails the build, and an ESLint rule refuses the import in a
 * component.
 *
 * ## Shape
 *
 * `better-auth` is an implementation detail confined to `auth-server.ts`. The
 * application depends on {@link AuthService} — `getOptionalUser`, `requireUser`,
 * `requireOnboardedUser` — and on nothing provider-specific.
 *
 * ## The rule that matters
 *
 * Identity comes from the session cookie and is re-derived from the database on
 * every request. A user identifier in a request body is input, never authority.
 */

export { createAuth, type CreateAuthOptions, type SpaceAuth } from './auth-server';

export {
  createAuthService,
  type AuthService,
  type AuthenticatedUser,
  type SessionContext,
  type CreateAuthServiceOptions,
} from './service';

export { AuthenticationRequiredError, OnboardingRequiredError, ForbiddenError } from './errors';

export {
  completeOnboarding,
  needsOnboarding,
  onboardingSchema,
  type OnboardingInput,
  type OnboardingResult,
} from './onboarding';

export {
  InMemoryRateLimiter,
  AUTH_RATE_LIMITS,
  type RateLimiter,
  type RateLimitDecision,
  type RateLimitRule,
} from './rate-limit';

export { createKeyring, generateEncryptionKey } from './crypto/keyring';
export type { Keyring, EncryptionKey } from './crypto/keyring';

export {
  encryptCredential,
  decryptCredential,
  isEncryptedCredential,
  readKeyId,
  CredentialCryptoError,
} from './crypto/aead';
export type { CredentialPurpose } from './crypto/aead';

export { createEncryptingPrismaAdapter } from './encrypting-adapter';

export {
  E2E_USER_EMAIL,
  E2E_USER_NAME,
  isE2EAuthAllowed,
  assertE2EAuthAllowed,
  e2eSecretMatches,
  E2EAuthDisabledError,
  type E2EAuthAllowance,
} from './e2e';
