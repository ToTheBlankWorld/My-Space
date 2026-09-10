# Stage 4 — Google Calendar import and background sync

This document records what Stage 4 built, why it is shaped the way it is, what
is verified and what is deliberately not verified yet. It is the engineering
report for the calendar feature shipped on top of the Stage 3 baseline.

- [A. Objective and scope](#a-objective-and-scope)
- [B. Early decisions](#b-early-decisions)
- [C. Data model and migrations](#c-data-model-and-migrations)
- [D. OAuth connect flow](#d-oauth-connect-flow)
- [E. Token custody](#e-token-custody)
- [F. Sync engine](#f-sync-engine)
- [G. Worker queue architecture](#g-worker-queue-architecture)
- [H. Concurrency and retry semantics](#h-concurrency-and-retry-semantics)
- [I. Auto-sync scheduling](#i-auto-sync-scheduling)
- [J. Audit events](#j-audit-events)
- [K. API surface](#k-api-surface)
- [L. Domain vocabulary and validation](#l-domain-vocabulary-and-validation)
- [M. Recurrence support](#m-recurrence-support)
- [N. Composition roots](#n-composition-roots)
- [O. Environment configuration](#o-environment-configuration)
- [P. Testing strategy](#p-testing-strategy)
- [Q. Security review](#q-security-review)
- [R. Performance considerations](#r-performance-considerations)
- [S. Known limitations and deferred work](#s-known-limitations-and-deferred-work)

---

## A. Objective and scope

Stage 4 imports a user's Google Calendar into Space so the scheduling engines
(Stage 5+) have a truthful picture of a user's real day, and keeps that picture
current with minimal intervention.

In scope:

- Google OAuth consent for calendar access, separate from identity sign-in.
- Encrypted custody of OAuth tokens in the database.
- A worker-side sync pipeline (BullMQ) that imports and copies calendar events.
- A schema migration carrying the connection tokens and recurrence fields.
- Deterministic auto-sync and audit events.

Explicitly out of scope (deferred to later stages):

- **Google Calendar writes.** The flow requests `calendar.readonly`; Space
  never mutates the user's calendar.
- **The Space Engine** (Part 22 items): nothing in this stage schedules,
  optimises or changes a user's plan. The calendar data is a new input, not a
  behaviour.

---

## B. Early decisions

| Decision                                                       | Why                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Import-only consent (`calendar.readonly`)                      | "Import" is the spec for this stage; a write scope is the smallest increment later and the largest consent surprise now.       |
| Identity and calendar consent are distinct flows               | An `id_token` (`sub`) identifies exactly which Google account consented; the console's `prompt=consent` covers rotation needs. |
| Tokens encrypted with `@space/auth` AEAD, `calendar.*` purpose | A calendar token can never be replayed into an identity column and vice versa; plaintext never reaches the database.           |
| All mutations cut on a server-side ownership key               | Every route and every job checks `(id, userId)` before reading or writing; job payloads carry only `userId` + `connectionId`.  |
| The queue produces from the web, consumes in the worker        | HTTP handlers never call Google aut h; they enqueue. The worker owns Redis, the provider and the database writes.              |
| BullMQ retries with exponential backoff, bounded               | `attempts: 3`, `backoff: exponential 5s`. Retryable vs permanent failures are classified per error type (see H).               |
| Redis `SET NX EX` lock per connection                          | Two concurrent syncs for one connection would interleave cursor updates and duplicate or drop events; see H.                   |
| Calendars mirrored at connect time, best-effort                | The dashboard has something to show before the first sync, and a transient Google error never undoes a successful connection.  |

---

## C. Data model and migrations

Migration `20260909120000_calendar_stage4`:

```sql
-- calendar_connections: encrypted tokens (AEAD ciphertext at rest)
ADD COLUMN     "accessToken" TEXT,
ADD COLUMN     "refreshToken" TEXT,
ADD COLUMN     "accessTokenExpiresAt" TIMESTAMPTZ(3);

-- calendar_events: recurrence linkage
ADD COLUMN     "recurringEventId" TEXT,
ADD COLUMN     "originalStartAt" TIMESTAMPTZ(3);
CREATE INDEX "calendar_events_userId_recurringEventId_idx"
  ON "calendar_events"("userId", "recurringEventId");
```

Migration `20260909130000_calendar_event_types` adds the audit vocabulary
(plain `ALTER TYPE ... ADD VALUE`; Postgres 12+ supports several per migration):

```sql
ALTER TYPE "EventType"      ADD VALUE 'CALENDAR_CONNECTED';
ALTER TYPE "EventType"      ADD VALUE 'CALENDAR_DISCONNECTED';
ALTER TYPE "EventType"      ADD VALUE 'CALENDAR_SYNCED';
ALTER TYPE "EventType"      ADD VALUE 'CALENDAR_SYNC_FAILED';
ALTER TYPE "AggregateType"  ADD VALUE 'CALENDAR_CONNECTION';
```

Both are generated with `prisma migrate diff --from-schema`, then applied by
`prisma migrate deploy` in CI. The enum-parity test in `@space/database`
(`enum-parity.test.ts`) pins the domain constants, the validation schemas and
the Prisma enums to identical value sets, so a value can never be accepted by
validation and rejected by the database.

### Column semantics

- `accessToken` / `refreshToken` hold **AEAD ciphertext** (`spc.v1.<keyId>
.<nonce>.<ciphertext>.<tag>`), never plaintext. `accessTokenExpiresAt` is
  plain (it is a freshness hint, not a secret).
- `recurringEventId` groups occurrences of one Google recurring series;
  `originalStartAt` records the original start of a moved instance — the two
  columns the engine needs to reason about a series without contacting Google.

---

## D. OAuth connect flow

1. `POST /api/calendar/connection` (authenticated) builds the consent URL with
   a fresh random `state` (`randomBytes(32)`, base64url) and stores it in an
   HttpOnly, `SameSite=Lax` cookie `space_calendar_oauth_state` (maxAge 600s,
   `Secure` in production). Scope: `openid email profile` + `calendar.readonly`,
   `access_type=offline`, `prompt=consent`, `include_granted_scopes`.
2. The callback, `GET /api/calendar/callback`, is **unauthenticated by
   necessity** (Google does not know our session cookie). Its trust anchors are:
   - the `state` query value must equal the cookie set when the flow started —
     a mismatch discards the code (CSRF);
   - the `code` is exchanged immediately and never logged;
   - the **Google account** is the `sub` of the verified id token (fallback: the
     bound `Account.accountId`), never a client claim.
3. A consent that returns **no refresh token** redirects to
   `<dashboard>?calendar=norefresh` and stores nothing: a connection that cannot
   refresh while the user is away is not a working sync.
4. On success, tokens are encrypted and persisted via
   `upsertCalendarConnection` (keyed `userId + provider + providerAccountId`,
   so re-authorising updates instead of duplicating). Calendars are discovered
   and mirrored best-effort. `CALENDAR_CONNECTED` is appended to the event log.
5. When Redis is available the callback enqueues an immediate **full** sync and
   registers the connection's **repeatable auto-sync** job.

Every `error_param` Google can deliver (`denied`, `invalid` …) redirects to the
dashboard with a label under `?calendar=`. The state cookie is always cleared.

---

## E. Token custody

`@space/calendar/src/token-store.ts` is the only place tokens are encrypted or
decrypted. `@space/auth`'s AEAD (AES-256-GCM) already binds a purpose into the
authenticated data; the two new purposes are `calendar.accessToken` and
`calendar.refreshToken`.

- `encryptCalendarTokens` refuses empty access tokens; stores refresh tokens
  optionally (a missing refresh token is a legitimate state, an empty one is
  not).
- `decryptCalendarTokens` refuses plaintext (a row not in `spc.v1.*` format is
  a corruption signal) and throws when the ciphertext was encrypted for the
  wrong purpose.
- The plaintext exists in memory for the duration of one sync and nowhere else.
  It is never logged, mirrored, or returned from an API. The logger redacts
  `token`-shaped paths globally.
- Encryption keys come from the environment (`OAUTH_ENCRYPTION_KEY`,
  `OAUTH_ENCRYPTION_PREVIOUS_KEYS`) and are built into a `Keyring` at process
  boot; a malformed key fails the process loudly, never silently.

---

## F. Sync engine

`@space/calendar/src/sync.ts` is provider-agnostic (adapter `CalendarProvider`,
Google implementation in `google-provider.ts`) and owns the database writes:

1. Load the connection and re-verify ownership (`id` + `userId`).
2. Load the target calendar; return empty on any miss (somebody deleted it).
3. Read the incremental sync cursor (null on first sync), unless `fullSync`.
4. Call the provider.
5. Tombstone or upsert events. Upsert is keyed `(calendarId, externalId)`, so a
   re-sync can never duplicate. CANCELLED events are soft-deleted (row kept,
   `deletedAt` set) because plans may reference them.
6. Persist the new cursor, `lastSyncedAt`, and clear `lastError*`.

`syncCalendar` handles one calendar; `syncAllCalendars` walks every selected
calendar, so one failing calendar never blocks the others (an empty result is
recorded for it and the loop continues).

---

## G. Worker queue architecture

The queue surface lives in `apps/worker/src/queues/index.ts`:

| Queue             | Name                     | Attempts | Backoff         | Consumed by          |
| ----------------- | ------------------------ | -------- | --------------- | -------------------- |
| `calendarSync`    | `space:calendar-sync`    | 3        | exponential 5s  | calendar-sync-worker |
| `calendarRefresh` | `space:calendar-refresh` | 2        | exponential 10s | (reserved)           |
| `maintenance`     | `space:maintenance`      | 1        | —               | maintenance-worker   |

The web application only ever **produces** (add) jobs; the worker owns all
consumers, the shared Redis connection, the database pool and the provider
calls. The worker boots without Redis or a database (every env var has a
default), and the calendar worker only starts when database + Google client +
keyring are all present — a partial configuration is a loud `warn`, not a
half-working sync.

---

## H. Concurrency and retry semantics

### Concurrency

BullMQ guarantees one _job_ is not processed twice in one worker, but two
processes (a rolling deploy) can both pick up the same connection. Two concurrent
syncs would interleave `read cursor → write events → write cursor` and corrupt
the mirror, so `sync-lock.ts` implements a per-connection lock: `SET key NX EX`
(4 min TTL) with a random owner; only the owner may release, so a TTL expiry
that lets a successor in can never delete the successor's lock. The loser
returns `{ skipped: 'locked' }` — the winner wrote the same state.

### Retry classification

The processor classifies every failure:

| Error class                     | State change                       | Job outcome               |
| ------------------------------- | ---------------------------------- | ------------------------- |
| `CalendarAuthError`             | connection → `ERROR`, `lastError*` | return success (no retry) |
| `CalendarPermissionError`       | connection → `ERROR`, `lastError*` | return success (no retry) |
| `CalendarSyncTokenExpiredError` | `syncCursor` cleared (full resync) | return success (no retry) |
| `CalendarValidationError`       | `lastError*` on CONNECTED          | return success (no retry) |
| `CalendarRateLimitError`        | `lastError*` on CONNECTED          | rethrow → BullMQ retries  |
| `CalendarTransientError`        | `lastError*` on CONNECTED          | rethrow → BullMQ retries  |
| anything else                   | logged loudly                      | rethrow → BullMQ retries  |

Permanent failures return success so BullMQ does not waste the retry budget on
errors a retry cannot fix; transient failures rethrow and let BullMQ back off.
`lastErrorMessage` is truncated at 500 chars; the message never contains a
token (the provider errors use static strings).

### Token refresh

`resolveConnectionAccessToken` re-verifies ownership, decrypts, and when the
stored access token is at or near expiry (30 s skew) with a refresh token
present, refreshes it, re-encrypts, persists the new ciphertext and expiry, and
returns the fresh token before the sync runs. A rejected refresh propagates as
`CalendarAuthError` → permanent failure. A connection with no refresh token
(single-use consent) is never blindly refreshed: it syncs with what it has.

---

## I. Auto-sync scheduling

Each CONNECTED connection gets one repeatable BullMQ job,
`auto-sync:<connectionId>`, at `CALENDAR_SYNC_INTERVAL_MINUTES` (default 15,
minimum 5).

- **Web** registers the repeatable job at connect time (`scheduleCalendarAutoSync`)
  plus an immediate full first sync.
- **Worker** re-registers every CONNECTED connection at boot
  (`apps/worker/src/scheduler.ts`), which is both the safety net for a
  connection that missed the web call and the self-healing for existing users
  when a new worker version deploys. The deterministic `jobId` makes the
  registration idempotent: BullMQ replaces rather than stacks.

---

## J. Audit events

`recordCalendarConnectionEvent` (in `@space/calendar`) appends to the append-only
event log under `aggregateType: CALENDAR_CONNECTION` and one of:

| Event                   | Emitted by                       | Payload highlights                               |
| ----------------------- | -------------------------------- | ------------------------------------------------ |
| `CALENDAR_CONNECTED`    | OAuth callback                   | provider, providerAccountId                      |
| `CALENDAR_DISCONNECTED` | disconnect route                 | provider                                         |
| `CALENDAR_SYNCED`       | sync worker on completion        | upserted, deleted, calendarId, fullSync          |
| `CALENDAR_SYNC_FAILED`  | sync worker on permanent failure | reason (`auth` / `scope` / `expired-sync-token`) |

The payload is bounded by the repository and never contains credentials.

---

## K. API surface

| Route                      | Method | Auth         | Behaviour                                                            |
| -------------------------- | ------ | ------------ | -------------------------------------------------------------------- |
| `/api/calendar/connection` | GET    | required     | Lists the user's connections with calendar counts                    |
| `/api/calendar/connection` | POST   | required     | Starts consent; sets the state cookie; returns `{ url }`             |
| `/api/calendar/callback`   | GET    | state cookie | Exchanges the code, stores tokens, mirrors calendars, redirects      |
| `/api/calendar/sync`       | POST   | required     | Ownership + CONNECTED check; enqueues; 503 when Redis is unavailable |
| `/api/calendar/status`     | GET    | required     | Connection status with `_count`                                      |
| `/api/calendar/calendars`  | GET    | required     | Calendars with connection info, selection and event counts           |
| `/api/calendar/disconnect` | POST   | required     | Best-effort revoke, then DISCONNECTED + deselect, event, 200         |

429/5xx from the sync endpoint are intentionally not produced by the HTTP layer:
rate limiting is Google-side and handled in the worker. The dashboard layers
(`?calendar=connected|denied|invalid|state|exchange|norefresh|identity`) are the
only user-facing error vocabulary.

---

## L. Domain vocabulary and validation

- `EVENT_TYPES` gained `CALENDAR_CONNECTED`, `CALENDAR_DISCONNECTED`,
  `CALENDAR_SYNCED`, `CALENDAR_SYNC_FAILED`.
- `AGGREGATE_TYPES` gained `CALENDAR_CONNECTION`.
- `upsertCalendarEventSchema` gained `recurringEventId` (an opaque provider id:
  bounded length, no control characters) and `originalStartAt` (an instant).

`@space/types` remains the single source of truth; the enum-parity test keeps
the Prisma enums and the validation schemas identical to it.

---

## M. Recurrence support

The schema, sync engine and upsert now carry `recurringEventId` and
`originalStartAt` for every normalized event. This is the **storage** half of
recurrence: occurrences of one series share an id and a moved instance keeps its
original start, which is everything the engine needs to group, re-derive or
re-program a series later. The expansion of recurrence rules into occurrences
is explicitly deferred (the `Recurrence` model and rule columns belong to a
later stage).

---

## N. Composition roots

- Web: `apps/web/src/server/calendar.ts` resolves `GoogleOAuthConfig` (redirect
  appended from `APP_URL`), the keyring, the logger and the database lazily and
  caches them on `globalThis`, mirroring the auth composition root.
- Worker: the bootstrap (`apps/worker/src/index.ts`) builds the keyring and
  Google credentials from its own env and passes them into the processor. The
  same keyring _must_ be shared across web and worker in a deployment — the
  web encrypts what the worker decrypts.

---

## O. Environment configuration

Variables added by this stage (all documented in `apps/web/.env.example`,
`apps/worker/.env.example` and the workspace reference):

| Variable                         | Reader       | Notes                                   |
| -------------------------------- | ------------ | --------------------------------------- |
| `REDIS_URL`                      | web + worker | BullMQ; web-only enqueues               |
| `CALENDAR_SYNC_INTERVAL_MINUTES` | web + worker | 5–1440, default 15                      |
| `GOOGLE_CLIENT_ID` / `_SECRET`   | web + worker | web for consent, worker for refresh     |
| `OAUTH_ENCRYPTION_KEY`           | web + worker | `<keyId>:<base64(32B)>`; shared keyring |
| `OAUTH_ENCRYPTION_PREVIOUS_KEYS` | web + worker | rotation only, comma-separated          |

`CALENDAR_SYNC_INTERVAL_MINUTES` is in `turbo.json` `globalEnv`. The worker
keeps its boot-without-secrets contract: every variable has a default or is
optional, and consumers start only when their inputs are complete.

---

## P. Testing strategy

Unit (no network, no database):

- `token-store.test.ts` — round-trip encryption, empty-token refusal,
  plaintext detection, cross-purpose rejection.
- `oauth.test.ts` — consent URL construction (scope, state, offline, redirect),
  scope constants.
- `resolve-access-token.test.ts` — ownership misses, non-CONNECTED, no refresh
  when unexpired or when no refresh token is present, refresh+re-encrypt
  persistence with the mock provider refresh.
- Existing sync classification / normalization / provider error tests.

Integration (skipped without `TEST_DATABASE_URL`, runs in CI):

- `persistence.test.ts::persists and updates recurrence linkage on repeated
syncs` — recurrence fields survive create and update without duplication.
- The whole pre-existing calendar persistence suite (idempotency, scope across
  calendars, overlap queries).

Live Google exchange is **not** unit-tested: `exchangeAuthorizationCode`,
`refreshAccessToken` and `getGoogleSubject` call Google. They are covered by the
typed error mapping and by manual/Acceptance verification with real
credentials. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and
`pnpm format:check` are all green (12 lint/typecheck tasks, 11 test tasks).

---

## Q. Security review

Findings of the focused review against the Stage 3 security posture:

- **No plaintext tokens at rest, in memory or in logs.** Encrypt/decrypt are
  isolated in `token-store`; ciphertext is what `upsertCalendarConnection`
  persists; the logger redacts `*Token` paths; the error messages that reach
  `lastErrorMessage` come from static strings. Scanned: passing.
- **Ownership on every path.** Routes and the sync engine each re-check
  `(id, userId)`. Job payloads carry no secrets and no authority.
- **OAuth integrity.** `state` is a 256-bit random bound to an HttpOnly cookie
  compared before any code exchange; codes are single-use, exchanged
  immediately, never logged; grants with no refresh token are discarded.
- **Purpose binding.** `calendar.*` AEAD purposes make cross-column/cross-feature
  token replay fail authentication.
- **Lock ownership.** The Redis sync lock can only be released by its owner,
  surviving TTL hand-offs safely.
- **Permanent-failure handling** keeps a revoked connection out of the retry
  loop while a transient failure keeps it retrying.

No High-severity findings. Medium items are tracked in S.

---

## R. Performance considerations

- Incremental syncs use Google's sync token after the first full sync, so
  steady-state work is proportional to the delta, not the whole calendar.
- Upserts are keyed on a composite unique index — re-syncs are idempotent
  point-writes.
- `calendar_events` carries `(userId, recurringEventId)` and pre-existing
  `(userId, startAt)`-style indexes, so the engines' future range and series
  queries stay index-only.
- The worker uses one shared Redis connection with BullMQ `concurrency: 2` and
  a 10/60s limiter to absorb provider burst limits.
- Event mirrors are buffered per-page by the provider; there is no open-ended
  in-memory growth.

---

## S. Known limitations and deferred work

1. **Live OAuth accepted only manually.** No unit/integration test performs a
   real Google exchange; that requires deploying with client credentials and a
   registered redirect URI. CI can't exercise it.
2. **Database-backed paths unverified locally.** No local Postgres/Redis, so the
   sync persistence suite and the queue consumer were validated by typecheck,
   lint and the integration suite that CI runs with a database. The migration
   files are hand-written from `migrate diff` and applied by `prisma migrate
deploy` in CI — not yet exercised against a live dev database.
3. **`calendarRefresh` queue is reserved**, not implemented: background refresh
   of tokens is currently driven in-line by the sync processor.
4. **Recurrence expansion** (rule columns → occurrence rows) is deliberately
   out of scope; storage linkage only.
5. **Calendar writes / scheduling** remain future stage work, as does the
   dashboard UI wiring for the `?calendar=` states.
6. No `docs/plans/` directory exists in this repository; the only planning
   artifact is this report, alongside `docs/authentication.md` and
   `docs/database.md`.
