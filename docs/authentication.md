# Authentication and sessions

Stage 3 of Space. This document covers the identity layer: what owns the user
record, how session state is managed, how third-party credentials are stored,
what the deterministic end-to-end route is, and how to run the test suite.

- [Account model](#account-model)
- [The server-only boundary](#the-server-only-boundary)
- [The session model](#the-session-model)
- [Third-party credential encryption](#third-party-credential-encryption)
- [The onboarding gate](#the-onboarding-gate)
- [Deterministic end-to-end sign-in](#deterministic-end-to-end-sign-in)
- [Package API](#package-api)
- [Local setup](#local-setup)
- [Testing](#testing)
- [Security](#security)
- [Performance](#performance)

---

## Account model

`better-auth` owns the account. Rather than inventing a custom identity
provider, Space uses the library's account and session tables, and adds one
column the library needs that Prisma did not generate during development:
`password`.

| Table          | Purpose                         | Notes                                                                         |
| -------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| `Account`      | A provider-specific credential  | Carries the token pair, granted scopes, and the provider user id              |
| `Session`      | A live login                    | Resolved from the session cookie on every authenticated page                  |
| `Verification` | Ephemeral state for OAuth flows | Nonce, state token, expiry — cleared after the callback                       |
| `User`         | The canonical account record    | `email`, `name`, `status`, `lastSeenAt`, `onboardingCompletedAt`, `password?` |

The `password` column is nullable and **unused in production**. It exists so
that `better-auth`'s email/password provider has somewhere to store the hash
when `E2E_AUTH_ENABLED` is set. Production never sets the flag: the `@space/config`
auth schema refuses it when `NODE_ENV=production`, which makes it a build-time
denial rather than a runtime one.

No second user table is ever created. The `User` row introduced in Stage 2 is
the single canonical source of truth for identity, preferences, working hours
and status. Every downstream table references this one row.

---

## The server-only boundary

`@space/auth` is server-only, like `@space/database`. Four mechanisms enforce
the boundary:

| Layer   | Mechanism                                               | Failure mode                                    |
| ------- | ------------------------------------------------------- | ----------------------------------------------- |
| Lint    | `no-restricted-imports` in `apps/web/eslint.config.mjs` | `pnpm lint` fails                               |
| Build   | `apps/web/src/server/auth.ts` imports `server-only`     | `next build` fails                              |
| Bundler | `serverExternalPackages` in `apps/web/next.config.ts`   | better-auth is never traced into a client chunk |
| Runtime | `assertServerRuntime()` in `createDatabaseClient`       | Throws if `window` exists                       |

The access flows one way:

```
Client Component  ─X─►  @space/auth
Server Component  ───►  apps/web/src/server/auth.ts  ───►  @space/auth
Route Handler     ───►  apps/web/src/server/auth.ts  ───►  @space/auth
```

---

## The session model

Sessions are stored in the database and resolved from a cookie on every page
load.

1. **Cookie name:** `better-auth.session_token`. HttpOnly, Secure (in
   production), `SameSite=Lax`, `Path=/`. The cookie is rotated on every
   resolved session and expires when the database row expires.
2. **Resolution:** `getOptionalUser(headers)` calls `auth.api.getSession` on every
   page load. The library reads the cookie, looks up the session row, checks
   expiry, and resolves the linked `User` row.
3. **Authorisation:** The session says _who_; the user row says _whether they
   may_. `getOptionalUser` re-checks `status` and `deletedAt` on every request
   rather than trusting the token. A suspended or soft-deleted account keeps its
   session rows until they expire or are revoked, so the denial is immediate.
4. **`lastSeenAt` refresh:** Written at most once per hour, so every authenticated
   page load does not add a write. The refresh uses the injected `Clock`, making
   it testable.
5. **Revocation:** `revokeAllSessions(userId)` deletes all `Session` rows for a
   user. The next request presenting an old cookie finds no row to resolve and
   becomes anonymous. The function returns the count of deleted rows.

### Paths the shell exposes

| Path          | Behaviour                                                                      |
| ------------- | ------------------------------------------------------------------------------ |
| `/`           | Public landing page. The header shows "Sign in" for anonymous visitors.        |
| `/login`      | Google sign-in button. Redirects to `/dashboard` if already authenticated.     |
| `/onboarding` | Collects timezone, locale, working hours, preferences. Redirects if onboarded. |
| `/dashboard`  | Application shell. Requires a fully onboarded session.                         |

`LOGIN_PATH`, `ONBOARDING_PATH`, and `DASHBOARD_PATH` are constants in
`apps/web/src/server/session.ts`, not hard-coded strings, so a rename is a
single-file change.

---

## Third-party credential encryption

OAuth refresh tokens and access tokens are stored in the `Account` table and
encrypted at rest with a dedicated, versioned keyring.

The keyring is a small in-memory structure holding an `activeKey` and zero or
more `previousKeys`. Each key carries a `keyId` (12 characters, part of the
composite value `keyId:base64`) so that a stored credential can be decrypted
with the correct version even after rotation. The rotation protocol is
**previous key holds old data, new key is active, decrypt with either**:

1. Generate a new key: `pnpm auth:rotate-key`.
2. Put its composite value in `OAUTH_ENCRYPTION_KEY`.
3. Put the old value (or a comma-separated list of old values) in
   `OAUTH_ENCRYPTION_PREVIOUS_KEYS`.
4. Decrypt existing records with either the active or any previous key; encrypt
   only with the active key.
5. Remove the oldest key from `OAUTH_ENCRYPTION_PREVIOUS_KEYS` once all
   credentials encrypted under it have been re-saved.

Encryption is AEAD (AES-256-GCM) with a purpose-bound associated data
string, so a token encrypted for calendar sync cannot be decrypted as though it
were a session key. The full implementation lives in
`packages/auth/src/crypto/aead.ts`.

---

## The onboarding gate

The planner cannot function without a timezone, working hours and an autonomy
level. Rather than letting every protected page remember this check, the
application shell calls `requireOnboardedUser()` which either resolves a full
session or redirects to `/onboarding` — a single, auditable gate.

`completeOnboarding` writes `UserPreferences`, `PlanningPreferences` and
`WorkingHoursBlock` inside one database transaction, then stamps
`onboardingCompletedAt`. The writes are all upserts or full replacements, so
a double submit or a re-visit updates rather than duplicates. The transaction
ensures the scheduler never sees a timezone but no working hours, which would
be worse than no answers at all.

---

## Deterministic end-to-end sign-in

Real OAuth has no headless path: Google's consent screen is a human shape a
test runner cannot walk through. Without a deterministic test identity, the
entire session surface — login redirects, the onboarding gate, sign-out — would
ship with zero coverage.

This is the deterministic route, and it is built so that it _cannot_ be enabled
in production:

1. `E2E_AUTH_ENABLED` is only honoured when `NODE_ENV` is not `production`: the
   `@space/config/auth` schema makes a production process with the flag set fail
   to boot.
2. `assertE2EAuthAllowed` re-checks the flag, the environment name and the
   secret on every call, so the route is a 500 even if the process boots in a
   strange configuration.
3. The test client must present `E2E_AUTH_SECRET`, compared in constant time, so
   an attacker who reaches a mis-configured deployment still cannot obtain a
   session without the secret.

The fixed identity is `e2e@space.test`. The route resets
`onboardingCompletedAt` on every call, so a re-run always exercises the full
login → onboarding → dashboard flow from scratch. The `password` column on the
`User` model exists solely for this route: `better-auth` stores the hash on the
user row when email/password is enabled.

The credentials are never given calendar access or any other real capability.
The route exists only so a CI pipeline can assert that the session flow works.

### How it works

```
POST /api/auth/e2e   body: { secret: <E2E_AUTH_SECRET> }
          │
          ├─ assertE2EAuthAllowed (env guard)
          ├─ constant-time secret check
          ├─ ensure e2e@space.test exists (signUpEmail if needed)
          ├─ reset onboardingCompletedAt → null
          ├─ signInEmail (session cookie set by nextCookies plugin)
          └─ redirect to /onboarding
```

---

## Package API

The application never imports `better-auth` directly. Everything goes through
`@space/auth`:

```ts
import { createAuthService, type AuthService } from '@space/auth';

const service = createAuthService({ auth, database, logger, clock });

const session = await service.getOptionalUser(headers);
if (session) {
  console.log(session.user.email);
}
```

Three rules shape this API:

1. **Identity comes from the cookie.** A user identifier in a request body is
   input, never authority. `requireUser` throws `AuthenticationRequiredError`
   when no session exists.
2. **The clock is injected.** Session expiry and `lastSeenAt` use the clock the
   composition root provides, so a test can move time and observe an expired
   session or a refreshed timestamp.
3. **`auth` is exposed only for the catch-all route handler.** The `betterAuth`
   instance is a property of `AuthService` so that
   `toNextJsHandler(getAuthService().auth)` works, but nothing outside the
   composition roots should call it directly.

---

## Local setup

```bash
# 1. set auth secrets in apps/web/.env.local
AUTH_SECRET=$(openssl rand -hex 32)
GOOGLE_CLIENT_ID=<your-google-client-id>
GOOGLE_CLIENT_SECRET=<your-google-client-secret>

# 2. generate the AEAD key for OAuth token storage
OAUTH_ENCRYPTION_KEY=$(node -e "const k=crypto.randomUUID().slice(0,12); const b=crypto.randomBytes(32).toString('base64'); console.log(k+':'+b)")

# 3. apply the latest migration (adds the nullable password column)
pnpm db:migrate:deploy
```

For end-to-end tests only:

```bash
E2E_AUTH_ENABLED=true
E2E_AUTH_SECRET=$(openssl rand -hex 32)
```

Neither is set in production: the auth schema refuses the flag when
`NODE_ENV=production`.

---

## Testing

| Suite             | Command                 | Needs a database |
| ----------------- | ----------------------- | ---------------- |
| Unit              | `pnpm test`             | No               |
| Integration       | `pnpm test:integration` | Yes              |
| End-to-end (auth) | `pnpm test:e2e`         | Yes              |

### What is covered

- `@space/auth` unit tests: AEAD encrypt/decrypt round-trip, keyring rotation
  with a previous key, `assertE2EAuthAllowed` accepts a valid allowance and
  rejects disabled and production configurations, `e2eSecretMatches` rejects
  mismatched secrets with constant-time semantics, `completeOnboarding` writes
  the three tables and stamps `onboardingCompletedAt`, the `InMemoryRateLimiter`
  respects the window and the limit.

- `@space/config` unit test: auth env schema refuses `E2E_AUTH_ENABLED` in
  production and enforces the minimum secret length when the flag is set.

- `apps/web` end-to-end tests: the landing page renders correctly and the header
  shows a "Sign in" link when anonymous, the login page renders the Google
  button, the onboarding page redirects authenticated users, and the dashboard
  redirects anonymous users to login.

### What is not covered locally

The integration and end-to-end suites need a live PostgreSQL instance. The CI
pipeline provides one; local development without Docker relies on the CI result.

---

## Security

- **No credential is ever logged.** The logger bridge reads only duration and
  component, never request bodies, tokens or error text that could carry a
  secret.
- **`nextCookies`** flushes `set-cookie` response headers through the Next.js
  cookie store rather than returning them in the response body, so a server
  component that reads the session does not echo the token.
- **Cookies are secure.** HttpOnly, Secure (in production), `SameSite=Lax`,
  `Path=/`, and rotated on every resolved session. `trustedOrigins` rejects a
  `callbackURL` pointing at another host, which is the open-redirect defence.
- **The E2E route is disabled at build time.** `E2E_AUTH_ENABLED` in production
  causes an environment schema error before the process boots. The route
  re-checks on every call, so a mis-configuration caught at the environment
  boundary cannot silently make the endpoint reachable.
- **The E2E secret is compared in constant time.** `e2eSecretMatches` uses
  `crypto.timingSafeEqual` with a length pre-check, so the secret cannot be
  extracted through timing.
- **Encryption uses AEAD.** Each credential purpose has an associated data
  string, so a token encrypted for one purpose cannot be decrypted as though it
  were for another.
- **Key rotation is safe.** Decryption tries the active key first, then the
  previous keys. Encryption always uses the active key. There is no gap where a
  credential cannot be read and no gap where a credential is written under a
  stale key.
- **No PII is stored in sessions.** The session row carries a user id and
  expiry; `User.name` and `User.email` are read on every request from the
  `User` row directly, so a profile update takes effect immediately without
  invalidating sessions.
- **`revokeAllSessions` is immediate.** The rows are deleted, not marked: the
  next request with an old cookie finds no row to resolve.

---

## Performance

- **Session resolution is one database lookup.** `getOptionalUser` reads the
  session row, the user row, and — at most once per hour — writes a
  `lastSeenAt` update. The write is idempotent and off the critical path.
- **The in-memory rate limiter is bounded.** `InMemoryRateLimiter` holds at most
  10 000 live windows per process and evicts expired entries when full. It is
  not a security control: it is a cost raiser for trivial abuse and a seam that
  Stage 7 replaces with a distributed implementation without touching call
  sites.
- **Encryption is per-request at most.** The keyring is in memory; encryption
  and decryption are AES-256-GCM with a fixed associated data string. The cost
  is negligible compared to the database round-trip.
- **`lastSeenAt` is written at most once per hour.** The refresh guard avoids a
  write on every authenticated page load, which would add write amplification
  for information that is only ever read at hour granularity.
