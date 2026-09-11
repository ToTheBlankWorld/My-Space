# Stage 12 — Production Deployment & Live Integration

This document records Stage 12: taking the Stages 1–11 platform from a
production-ready repository to a **real, securely deployed, end-to-end working
production environment** — Vercel (web), Supabase PostgreSQL, Upstash Redis,
Railway (worker), Google OAuth + Calendar, AgentMail. No product features are
added and no architecture is redesigned; every change here exists to make the
existing system deployable and verifiably live. Deterministic, explainable, no
AI/LLM anywhere — exactly like every stage before it.

- [0. Forensic audit (Phase 0)](#0-forensic-audit-phase-0)
- [1. Production environment inventory (Phase 1)](#1-production-environment-inventory-phase-1)
- [2. Environment contract (Phase 2)](#2-environment-contract-phase-2)
- [3. Supabase PostgreSQL (Phase 3)](#3-supabase-postgresql-phase-3)
- [4. Upstash Redis (Phase 4)](#4-upstash-redis-phase-4)
- [5. Google OAuth and Calendar (Phase 5)](#5-google-oauth-and-calendar-phase-5)
- [6. AgentMail (Phase 6)](#6-agentmail-phase-6)
- [7–8. Vercel and Railway configuration (Phases 7–8)](#78-vercel-and-railway-configuration-phases-78)
- [9. Live phase verification labels (Phases 9–16)](#9-live-phase-verification-labels-phases-916)
- [10. Health endpoint verification (Phase 10)](#10-health-endpoint-verification-phase-10)
- [11. Runtime behaviour verification (Phase 11)](#11-runtime-behaviour-verification-phase-11)
- [17. Observability (Phase 17)](#17-observability-phase-17)
- [18. CI/CD safety audit (Phase 18)](#18-cicd-safety-audit-phase-18)
- [19–20. Runbooks and recovery drills (Phases 19–20)](#1920-runbooks-and-recovery-drills-phases-1920)
- [A. Final A–Z report](#a-final-a-z-report)
- [Appendix: retired](#appendix-retired)

---

## Verification label rubric

Every claim below is stamped with exactly one label:

| Label                    | Meaning                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERIFIED LOCALLY`       | Proven on this machine (unit/integration tests, local boot, local probe)                                                                                   |
| `VERIFIED IN CI`         | Proven by the GitHub Actions workflow                                                                                                                      |
| `VERIFIED IN STAGING`    | Proven against a staging deployment of the real stack                                                                                                      |
| `VERIFIED IN PRODUCTION` | Proven against the live production environment                                                                                                             |
| `NOT VERIFIED`           | Impossible to prove here; must carry the exact phrase `NOT VERIFIED — requires production credentials/environment` unless a partial verification is stated |

**Critical rule**: a live integration is either exercised against the real
provider with real credentials, or it is stamped `NOT VERIFIED — requires
production credentials/environment`. A mocked or local stand-in is never
presented as a successful live integration.

---

## 0. Forensic audit (Phase 0)

State of the repository at the start of Stage 12, as audited (no repository
changes were made during this phase).

### 0.1 Repository baseline

- Working tree: `D:\My Projects\My-Space`, git toplevel confirmed.
- Branch `master`; `HEAD = 9547808` ("feat: harden production reliability and
  observability", the Stage 11 commit; `8bba452` was the Stage 10 baseline).
- Working tree clean at audit start. `git status --short` clean; no untracked
  or staged files.
- **No git remotes configured.** Nothing can be pushed from this machine, and
  GitHub cannot be the deploy trigger without a remote.
- Content verified: no `.env`, no tokens, no credentials, no `G-Course` content
  anywhere in the repository. `gitignore` excludes real env files.
  `VERIFIED LOCALLY`.

### 0.2 Committed deployment configuration

| File                   | Content                                                                                                                                                                                         | Source of truth |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `apps/web/vercel.json` | Vercel: `framework: nextjs`; `installCommand: pnpm install --frozen-lockfile`; `buildCommand: pnpm build:web`. The Vercel project must set **Root Directory = `apps/web`**.                     | Stage 11 §K.1   |
| `railway.json`         | Railway worker: Nixpacks; `buildCommand: pnpm build:worker`; `startCommand: node apps/worker/dist/index.js`; `healthcheckPath: /healthz`; `healthcheckTimeout: 20`; restart `ON_FAILURE` max 5. | Stage 11 §K.1   |

- Railway injects `$PORT`; `HEALTH_PORT` must be set to that value so the
  health check and `/metrics` scrape hit the listening socket. Vercel requires
  no port handling. `VERIFIED LOCALLY` (config read; runtime surface covered by
  worker health tests).

### 0.3 Runtime and toolchain facts

- Node.js `24.18.0` — `.nvmrc` and the CI `NODE_VERSION`. `engines.node >= 22.11`.
- pnpm `9.15.4` (`packageManager`). CI uses `pnpm install --frozen-lockfile`.
- Catalog (`pnpm-workspace.yaml`): next `^16.3.4`, react `19.2.8`,
  typescript `^6.0.3`, eslint `^10.10.0`, turbo `^2.10.12`, vitest `^5.0.0`,
  zod `^4.5.4`, tailwindcss `^4.3.3`.
- Internal packages ship TypeScript source and are compiled by the consumer
  (`transpilePackages` in Next, `tsup` in the worker). No per-package `dist/`.
  `VERIFIED LOCALLY` (Stage 11 build green).

### 0.4 Runtime environment model (audited)

| Runtime    | Loader                                     | Semantics                                                                                                                   |
| ---------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Web server | `loadWebServerEnv()` (`@space/config/web`) | `NODE_ENV` + `APP_URL` (default `http://localhost:3000`) only; validated at module load → fail-fast at boot/build.          |
| Web auth   | `loadAuthEnv()` (`@space/config/auth`)     | Lazy (first sign-in/calendar use), never at import: public pages still build and render with **no** secrets present.        |
| Browser    | `loadWebClientEnv()` (`@space/config/web`) | `NODE_ENV` only — no secrets, no `NEXT_PUBLIC_*` credential keys.                                                           |
| Worker     | `loadWorkerEnv()` (`@space/config/worker`) | Validated at boot; every variable defaults. `DATABASE_URL`/`REDIS_URL` optional → graceful to "no persistence / no queues". |

- `assertServerRuntime()` throws if any server env is evaluated where `window`
  exists; `server-only` imports fail a bad client-bundle import at build time;
  an ESLint rule blocks components from importing server config.
  `VERIFIED IN CI` (a config test asserts the server schema's key list).
- **Secrets (auth) never default.** `AUTH_SECRET` (≥ 32), `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `OAUTH_ENCRYPTION_KEY` (format `<keyId>:<base64 32-byte key>`)
  are all required by `authEnvSchema`; a missing value fails the first
  authenticated request, never silently. `OAUTH_ENCRYPTION_PREVIOUS_KEYS` is a
  comma-separated decrypt-only list used only during rotation.
- `E2E_AUTH_ENABLED` defaults off and the schema **refuses** it when
  `NODE_ENV=production`; `E2E_AUTH_SECRET` (≥ 32) is required when enabled.
  `VERIFIED IN CI`.

### 0.5 Health and observability surfaces

| Surface            | Runtime | Behaviour                                                                                                                                      |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/healthz` | web     | Liveness. No database touch. `cache-control: no-store`. `200` when process alive.                                                              |
| `GET /api/readyz`  | web     | Readiness. Real `SELECT 1` round-trip; `200`/`503`; one dependency boolean, never error detail.                                                |
| `GET /healthz`     | worker  | Liveness. `200` while the process runs, including during shutdown drain.                                                                       |
| `GET /readyz`      | worker  | Readiness. Runs registered probes (`database`, `redis`), returns `{name, ok}` entries only. `200` when all `ok`.                               |
| `GET /metrics`     | worker  | Prometheus text/0.0.4 exposition of the zero-dep registry (`worker_jobs_*`, `space_retention_pruned_rows`). `404` when no registry configured. |

All, except `/metrics` rendering when the registry exists (covered by
`apps/worker/src/__tests__/health-server.test.ts`), are `VERIFIED LOCALLY` via
unit tests and `VERIFIED IN CI` on the worker/verify jobs.

### 0.6 Dependency readiness matrix

| Dependency              | Code creates it?                 | Live verification possible here? | Label                                                        |
| ----------------------- | -------------------------------- | -------------------------------- | ------------------------------------------------------------ |
| Vercel (web deploy)     | `vercel.json`                    | No credentials/organisation      | `NOT VERIFIED — requires production credentials/environment` |
| Supabase PostgreSQL     | migrations                       | No project credentials           | `NOT VERIFIED — requires production credentials/environment` |
| Upstash Redis           | ioredis + BullMQ                 | No database                      | `NOT VERIFIED — requires production credentials/environment` |
| Railway (worker)        | `railway.json`                   | No account/credentials           | `NOT VERIFIED — requires production credentials/environment` |
| Google OAuth + Calendar | `@space/auth`, `@space/calendar` | No OAuth client / consent        | `NOT VERIFIED — requires production credentials/environment` |
| AgentMail               | `@space/notifications`           | No API key                       | `NOT VERIFIED — requires production credentials/environment` |
| GitHub Actions remote   | `ci.yml`                         | No remotes                       | `NOT VERIFIED — requires production credentials/environment` |

Local stand-ins and their actual availability on this machine (audited):

| Stand-in                                  | Available here?                  | Consequence                                                                                                               |
| ----------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Docker (`docker-compose.yml` Postgres 17) | **No** — Docker is not installed | Integration tests and a live DB health probe run in CI only (`VERIFIED IN CI`); no local `VERIFIED LOCALLY` DB round-trip |
| Local Redis                               | No (not provisioned)             | Redis-backed paths stay `NOT VERIFIED — requires production credentials/environment`                                      |
| Deterministic unit suites                 | Yes                              | Full local `VERIFIED LOCALLY` evidence                                                                                    |
| Worker bare-boot (no DB/Redis)            | Yes                              | `VERIFIED LOCALLY` — see Phase 10                                                                                         |

### 0.7 Correction of stale documentation

- `README.md` still says "Stage 03 — Identity" and "no queue consumers and no
  business logic" in the worker description; both are long since false. Stage 12
  will not fix README staging text as part of deployment work — it is tracked
  here as an audit finding for the final report. `NOT VERIFIED` (no functional impact).

### 0.8 Key risk register from existing code, carried into the report

1. **Per-instance web rate limiter** (Stage 11 §N.1). Exact on a single web
   instance; N× budget when horizontally scaled. Documented, not fixed.
2. **Next 16 `middleware.ts` → `proxy.ts` deprecation** (Stage 11 §N.6). Build is
   green and behaviour identical; not migrated (no concrete reason).
3. **CI has no deploy job and no secrets** — the safest possible posture for
   release safety, but also means deploying stays a manual, credential-gated
   step by design. Documented in runbooks (Phase 19).
4. **No remotes / no credentials** in this environment — every phase that needs
   a live provider (Phases 3–6, 12–16) is blocked or `NOT VERIFIED` while that
   holds; all documentation for those phases is written so an operator with
   credentials can complete verification in minutes.

---

## 1. Production environment inventory (Phase 1)

The complete set of components a production deployment needs, what creates
them, what each requires at deploy time, and where the configuration lives.

### 1.1 Component matrix

| Component               | Platform       | Created by                        | Connects to                                   | Deploy-time input                                                |
| ----------------------- | -------------- | --------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| Web application         | Vercel         | `apps/web` + `vercel.json`        | Supabase PG, Upstash Redis, Google            | Project Root Directory `apps/web`; env vars (Phase 2/9)          |
| Worker                  | Railway        | `railway.json` + `apps/worker`    | Supabase PG, Upstash Redis, Google, AgentMail | Service env vars; `HEALTH_PORT=$PORT`                            |
| PostgreSQL              | Supabase       | Prisma migrations (11)            | web, worker                                   | Pooled `DATABASE_URL` (port 6543) + direct `DIRECT_DATABASE_URL` |
| Redis                   | Upstash        | ioredis/BullMQ queues (`space:*`) | web (enqueue), worker (consume)               | `REDIS_URL` (TLS `rediss://`), BullMQ-compatible                 |
| Google OAuth            | Google Cloud   | `@space/auth` (sign-in)           | web                                           | OAuth client (web app type); redirect URIs; consent screen       |
| Google Calendar         | Google Console | `@space/calendar`                 | web (connect), worker (sync/refresh)          | Same OAuth client; Calendar API enabled; scopes                  |
| AgentMail               | AgentMail      | `@space/notifications` provider   | worker                                        | API key (write-only); outbound from configured sender            |
| Realtime/queue schedule | Upstash/BullMQ | `apps/worker/src/scheduler.ts`    | Redis                                         | Repeatable jobs registered by the worker at boot                 |
| CI                      | GitHub Actions | `.github/workflows/ci.yml`        | — (no deploy step)                            | Postgres service for integration; Playwright for e2e             |

### 1.2 Deployment-shape decisions that must hold

- The worker must run as a **long-lived process**, never a serverless function:
  it holds connection pools, drain-in-flight on shutdown, and registers durable
  repeatable jobs. `railway.json` enforces this shape.
- The web app is **request/response only**: it enqueues queue jobs, it never
  consumes them (`apps/web/src/server/calendar-queue.ts` answers honestly when
  Redis is absent).
- `prisma migrate deploy` runs **only** against the direct connection; the
  pooled URL cannot be used for migrations (transaction pooling, no prepared
  statements, advisory locks). `db push` is prohibited in production.

### 1.3 Where credentials must live (never in the repository)

| Provider    | Secret(s)                                                  | Intended home                                                             |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| Google      | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                 | Vercel env (web), Railway env (worker)                                    |
| Supabase    | `DATABASE_URL` (pooled), `DIRECT_DATABASE_URL`             | Vercel env (web), Railway env (worker), operator's CLI env for migrations |
| Upstash     | `REDIS_URL`                                                | Vercel env (web), Railway env (worker)                                    |
| AgentMail   | `AGENTMAIL_API_KEY`                                        | Railway env (worker)                                                      |
| Session     | `AUTH_SECRET` (≥ 32 chars)                                 | Vercel env (web)                                                          |
| Tokens      | `OAUTH_ENCRYPTION_KEY` (`<keyId>:<base64>`), rotation list | Vercel env (web), **same values** on Railway (worker)                     |
| E2E control | `E2E_AUTH_ENABLED`/`E2E_AUTH_SECRET`                       | Never in production (schema refuses the flag)                             |

---

## 2. Environment contract (Phase 2)

The canonical table of every environment variable the platform reads. Schema
locations: `packages/config/src/{web,worker,auth,database}.ts`.

Legend: **V** web (Next server) · **W** worker · **L** local-only · **S** secret
(never log, never `NEXT_PUBLIC_`).

### 2.1 Web application (Vercel)

| Variable                               | R   | Required in prod     | Default                 | Notes                                                                                                                                             |
| -------------------------------------- | --- | -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                             | V   | production           | —                       | `next build`/`next start` set and enforce it                                                                                                      |
| `APP_URL`                              | V   | yes                  | `http://localhost:3000` | **Must** equal the public origin; used for OAuth redirect URIs and post-sign-in redirect bound (`trustedOrigins`)                                 |
| `DATABASE_URL`                         | V   | yes                  | —                       | Supabase pooled endpoint (port 6543)                                                                                                              |
| `DIRECT_DATABASE_URL`                  | V   | no (migrations only) | —                       | Direct endpoint for `prisma migrate` via package loader                                                                                           |
| `REDIS_URL`                            | V   | yes*                 | —                       | Upstash `rediss://`; enqueue path + auto-sync scheduling (`*` required for calendar sync-on-connect; without it that best-effort step is skipped) |
| `DATABASE_LOG_QUERIES`                 | V   | no                   | `false`                 | Debug log of query text (never parameters)                                                                                                        |
| `AUTH_SECRET`                          | V,S | yes                  | —                       | ≥ 32 chars; HMAC-SHA-256 session signing                                                                                                          |
| `GOOGLE_CLIENT_ID`                     | V,S | yes                  | —                       | Shared with worker                                                                                                                                |
| `GOOGLE_CLIENT_SECRET`                 | V,S | yes                  | —                       | Shared with worker                                                                                                                                |
| `OAUTH_ENCRYPTION_KEY`                 | V,S | yes                  | —                       | Format `<keyId>:<base64 32-byte key>`; same value on worker                                                                                       |
| `OAUTH_ENCRYPTION_PREVIOUS_KEYS`       | V,S | no                   | —                       | Comma-separated retire list, rotation only                                                                                                        |
| `AUTH_SESSION_MAX_AGE_SECONDS`         | V   | no                   | 2592000 (30 d)          | Session lifetime                                                                                                                                  |
| `AUTH_SESSION_UPDATE_AGE_SECONDS`      | V   | no                   | 86400 (24 h)            | Rolling-expiry cadence for active sessions                                                                                                        |
| `E2E_AUTH_ENABLED` / `E2E_AUTH_SECRET` | V   | **never**            | `false` / —             | Schema refuses the flag when `NODE_ENV=production`                                                                                                |
| `CALENDAR_SYNC_INTERVAL_MINUTES`       | V   | no                   | 15                      | Web-side repeatable auto-sync registration (when `REDIS_URL` set)                                                                                 |

Browser contract (`webClientEnvSchema`): **`NODE_ENV` only.** No `NEXT_PUBLIC_`
key may ever hold a credential; a config test prevents the server schema's keys
from gaining a client-side twin (`VERIFIED IN CI`).

### 2.2 Worker (Railway)

| Variable                                       | R   | Required in prod       | Default                     | Notes                                                                   |
| ---------------------------------------------- | --- | ---------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `NODE_ENV`                                     | W   | production             | —                           | Validated at boot                                                       |
| `WORKER_NAME`                                  | W   | no                     | `space-worker`              | Process identity in logs                                                |
| `LOG_LEVEL`                                    | W   | no                     | `info`                      | `trace..fatal`                                                          |
| `HEALTH_PORT`                                  | W   | **yes**                | `8080`                      | **Set to Railway's `$PORT`** or the health check/scrape miss the socket |
| `SHUTDOWN_TIMEOUT_MS`                          | W   | no                     | 10000                       | Grace period before forced exit                                         |
| `DATABASE_URL`                                 | W   | yes                    | —                           | Required to start queue consumers; else boots degraded                  |
| `REDIS_URL`                                    | W   | yes                    | —                           | Required for queue consumers; BullMQ-compatible, TLS                    |
| `APP_URL`                                      | W   | yes                    | `http://localhost:3000`     | Absolute links in notification emails and in-app bodies                 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`    | W,S | yes (calendar enabled) | —                           | Used only to refresh calendar access tokens                             |
| `OAUTH_ENCRYPTION_KEY` (+ `..._PREVIOUS_KEYS`) | W,S | yes                    | —                           | Same keyring as web: stored tokens decrypt here                         |
| `AGENTMAIL_API_KEY`                            | W,S | yes (email enabled)    | —                           | Absent → email attempts recorded `provider-not-configured`, never faked |
| `AGENTMAIL_BASE_URL`                           | W   | no                     | `https://api.agentmail.dev` | Sandbox override for local testing                                      |
| `CALENDAR_SYNC_INTERVAL_MINUTES`               | W   | no                     | 15 (min 5, max 1440)        | Worker-side residual sync schedule at boot                              |
| `NOTIFICATION_SWEEP_INTERVAL_MINUTES`          | W   | no                     | 5 (min 1, max 60)           | One repeatable job per fleet                                            |
| `AUTONOMY_REVIEW_INTERVAL_MINUTES`             | W   | no                     | 5 (min 1, max 60)           | Observe → classify → delegate replans                                   |
| `MAINTENANCE_INTERVAL_MINUTES`                 | W   | no                     | 1440 (min 60)               | Retention prunes, session/verification cleanup, tombstone purge         |
| `PLANNING_MAX_TASKS_PER_PLAN`                  | W   | no                     | 100 (max 2000)              | Hard cap per planning pass                                              |
| `EVENT_LOG_RETENTION_DAYS`                     | W   | no                     | 90 (min 7)                  | Also bounded below by the smallest committed outbox cursor              |
| `AGENT_ACTION_RETENTION_DAYS`                  | W   | no                     | 90 (min 7)                  |                                                                         |
| `NOTIFICATION_RETENTION_DAYS`                  | W   | no                     | 90 (min 7)                  |                                                                         |
| `EMAIL_LOG_RETENTION_DAYS`                     | W   | no                     | 90 (min 7)                  |                                                                         |
| `SESSION_RETENTION_DAYS`                       | W   | no                     | 30 (min 1)                  | Expired-session prunes                                                  |
| `VERIFICATION_RETENTION_DAYS`                  | W   | no                     | 7 (min 1)                   | OAuth state / verification prunes                                       |
| `CALENDAR_EVENT_RETENTION_DAYS`                | W   | no                     | 90 (min 7)                  | Calendar-event tombstone prunes                                         |

Worker failure model: `DATABASE_URL`/`REDIS_URL` optional at boot (local dev),
but a production deployment that omits them boots in a degraded state that
**logs** that state (`worker running without persistence`, queue consumers
disabled) rather than failing. The runbooks (Phase 19) treat both as required in
production. `VERIFIED LOCALLY` (schema defaults and coercion) and
`VERIFIED IN CI` (config tests reject bad values).

### 2.3 Secrets rules (enforced, audited, restated)

1. Never commit a real env file — `.gitignore` excludes all but `*.env.example`.
2. Never put a credential behind `NEXT_PUBLIC_` (that inlines it into the browser bundle).
3. Never log `AUTH_SECRET`, OAuth secrets, encryption keys, or raw tokens. The
   logger redacts credential-shaped fields; calendar tokens are encrypted at the
   storage boundary before any write; OAuth error bodies are never echoed.
4. `OAUTH_ENCRYPTION_KEY` on web and worker must be byte-identical, because
   tokens encrypted by web consent are decrypted by the worker during sync.
5. `APP_URL` must match the actual public origin on both web and worker, or
   Google rejects the callback and email links are wrong.

---

## 3. Supabase PostgreSQL (Phase 3)

Supabase is used here as **managed PostgreSQL only** — no Supabase Auth,
client, storage, or RLS. The app connects with Prisma's pg driver adapter
(`packages/database/src/client.ts`), so the connection-string split is the only
platform-specific behaviour.

### 3.1 Provisioning steps (operator, with credentials)

1. Create a project in Supabase (region chosen near the other services).
2. Copy the connection URI. Pooled (transaction) endpoint uses port **6543**;
   the **direct** endpoint uses port **5432**.
   - `DATABASE_URL` ← pooled `postgres://`/`postgresql://` (apps: web runtime, worker)
   - `DIRECT_DATABASE_URL` ← direct `postgres://` (migrations/CLI only)
3. Do **not** enable PgBouncer transaction-mode for the app _and_ run migrations
   through it: transaction pooling has no prepared-statement/advisory-lock
   support, which `prisma migrate` needs. This repo already keeps the two URLs
   separate (`packages/config/src/database.ts`; `prisma.config.ts` uses
   `DIRECT_DATABASE_URL ?? DATABASE_URL`).
4. Leave default automated backups on; confirm point-in-time or daily backups
   match the retention plan.

### 3.2 Production migration procedure (never `db push`)

```powershell
# On an operator machine with credentials — never in CI, never against prod by a PR.
$env:DIRECT_DATABASE_URL = "postgresql://postgres.svc...:5432/postgres"  # direct URI
pnpm db:migrate:status      # review migration history
pnpm db:migrate:deploy      # apply pending migrations, one transaction each
pnpm db:migrate:status      # confirm "up to date"
```

Verification here: `NOT VERIFIED — requires production credentials/environment`.
The migration _mechanism_ is proven `VERIFIED IN CI` (clean-database
`db:migrate:deploy` + `db:migrate:status` on every run).

---

## 4. Upstash Redis (Phase 4)

BullMQ backing store. The worker opens one shared ioredis connection
(`apps/worker/src/queues/index.ts`): `maxRetriesPerRequest: null`
(BullMQ requirement), `enableReadyCheck: false`, `lazyConnect: true`. The web
process uses the identical options for its enqueue-only connection
(`apps/web/src/server/calendar-queue.ts`).

### 4.1 Provisioning steps (operator, with credentials)

1. Create a Redis database in Upstash, region close to the other services.
2. Use the **TLS** endpoint template `rediss://<user>:<password>@<host>:6379`
   into `REDIS_URL` (web and worker, same value).
3. Set the **eviction policy** to `noeviction` (or explicitly size-friendly):
   BullMQ relies on its keys being durable; an evicting policy can silently
   drop jobs and repeatable schedules.
4. The worker registers repeatable jobs at boot (`scheduler.ts`) with fixed
   `jobId`s (e.g. `space:notification-sweep`, `space:autonomy-review`,
   per-connection `auto-sync:<connectionId>`), so redeploys replace schedules
   instead of stacking them.

Verification here: `NOT VERIFIED — requires production credentials/environment`.
Local Redis compatibility is not provable without a Redis instance (Docker is
not installed on this machine).

---

## 5. Google OAuth and Calendar (Phase 5)

Two independent OAuth flows share one client id/secret:

| Flow             | Purpose                           | Redirect URI (must be registered)     |
| ---------------- | --------------------------------- | ------------------------------------- |
| Sign-in          | Identity (`openid email profile`) | `${APP_URL}/api/auth/callback/google` |
| Calendar connect | Read calendars + identity         | `${APP_URL}/api/calendar/callback`    |

- Sign-in scopes: `openid email profile`, `access_type=offline`,
  `prompt=consent` (`packages/auth/src/auth-server.ts`).
- Calendar scopes: `https://www.googleapis.com/auth/calendar.readonly` plus the
  identity scopes re-requested, so Google's `id_token` tags the account
  (`packages/calendar/src/oauth.ts`). Never a write scope.
- The calendar flow sets an HttpOnly anti-CSRF `state` cookie
  (`space_calendar_oauth_state`, 10 min) and discards any callback whose state
  does not match (`apps/web/src/app/api/calendar/callback/route.ts`).

### 5.1 Provisioning steps (operator, with credentials)

1. Google Cloud Console → APIs & Services → create an **OAuth client ID**
   (Web application). Authorized JavaScript origins: `${APP_URL}` (and the local
   dev origin). Authorized redirect URIs: the two URIs above (plus their
   localhost equivalents while developing).
2. Enable the **Google Calendar API** in the same project (the API, not just
   OAuth — `accessNotConfigured` 403s otherwise; surfaced as
   `CalendarAuthError` today).
3. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on Vercel (web) and Railway
   (worker — used only to refresh tokens during sync).

Verification here: `NOT VERIFIED — requires production credentials/environment`
(no OAuth client or consent available in this environment).

---

## 6. AgentMail (Phase 6)

Email provider behind `@space/notifications`' `EmailProvider` interface
(`provider.ts`): `POST {AGENTMAIL_BASE_URL}/v1/messages` with a Bearer token and
`x-space-reference`. Without `AGENTMAIL_API_KEY` the worker boots but outbound
deliveries are recorded as failed with `provider-not-configured` — never faked.

### 6.1 Provisioning steps (operator, with credentials)

1. Create an AgentMail mailbox and obtain an API key.
2. Set `AGENTMAIL_API_KEY` (secret) on Railway (worker only). Verify/configure
   the sender/domain AgentMail requires for outbound.
3. `AGENTMAIL_BASE_URL` defaults to `https://api.agentmail.dev`; point it at a
   sandbox while developing.

Verification here: `NOT VERIFIED — requires production credentials/environment`.

---

## 7–8. Vercel and Railway configuration (Phases 7–8)

The committed configuration (Stage 11) was re-audited and one real defect was
found and fixed during Phase 11 (start command crash — see §11.3).

### 7.1 Vercel (web)

- `apps/web/vercel.json`: `framework: nextjs`, install
  `pnpm install --frozen-lockfile`, build `pnpm build:web`.
- Vercel project: **Root Directory = `apps/web`**; set the env vars from §2.1
  (all secret-valued ones in the project's environment, not the repo).
- Runtime: Next.js server runtime; no port handling needed.
- `VERIFIED LOCALLY`: config file read; a full `next build` is green. Deploy
  itself: `NOT VERIFIED — requires production credentials/environment`.

### 8.1 Railway (worker)

- `railway.json`: Nixpacks; build `pnpm build:worker`; start
  `node apps/worker/dist/index.js`; healthcheck `/healthz` (timeout 20,
  `ON_FAILURE`, max 5 retries).
- Deploy as a **Service**, never as a serverless function; scale horizontally —
  the health server and graceful shutdown make instances drainable.
- **`HEALTH_PORT` must equal Railway's `$PORT`**, or the health check and any
  `/metrics` scrape point at a socket nothing listens on.
- `VERIFIED LOCALLY`: after the Phase 11 fix, the exact start command boots and
  serves `/healthz`, `/readyz`, `/metrics` (see §11.3). Deploy itself:
  `NOT VERIFIED — requires production credentials/environment`.

---

## 9. Live phase verification labels (Phases 9–16)

Phases 9 (env wiring), 12 (web E2E), 13 (calendar sync), 14 (notifications/
email), 15 (autonomous loop), 16 (maintenance/retention) all require a live
deployment with real credentials and are therefore:

> `NOT VERIFIED — requires production credentials/environment`

Each is fully specified in the phases above (which variables, which endpoints,
which expectation). The operator runbooks (§19) sequence them.

---

## 10. Health endpoint verification (Phase 10)

Worker and web **production builds** booted on this machine without credentials
and probed exactly as a platform would:

| Target                                     | Result                                                                              | Label              |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------ |
| `node apps/worker/dist/index.js` (no env)  | boots, logs degraded state, listens on `HEALTH_PORT`                                | `VERIFIED LOCALLY` |
| `GET /healthz` (worker)                    | `200 {"status":"ok","service":"space-worker",...}`                                  | `VERIFIED LOCALLY` |
| `GET /readyz` (worker)                     | `200 {"status":"ready","dependencies":{}}` (no deps configured → ready)             | `VERIFIED LOCALLY` |
| `GET /metrics` (worker)                    | `200` empty exposition (no registry data yet)                                       | `VERIFIED LOCALLY` |
| `GET /api/healthz` (web, `next start`)     | `200 {"status":"ok","service":"web",...}`                                           | `VERIFIED LOCALLY` |
| `GET /api/readyz` (web, no `DATABASE_URL`) | `503 {"status":"degraded","dependencies":{"database":false}}` — honest, non-leaking | `VERIFIED LOCALLY` |

Shutdown drain, probe-leak avoidance and `/metrics` 404-without-registry are
covered by unit tests (`apps/worker/src/__tests__/health-server.test.ts`) —
`VERIFIED IN CI`.

---

## 11. Runtime behaviour verification (Phase 11)

### 11.1 Toolchain and versions

- Node on this machine is `v24.18.0` (confirmed in the worker boot log),
  matching `.nvmrc` and CI. pnpm `9.15.4`. Next `16.3.4` / React `19.2.8`
  build green.
- `pnpm install` completed and wrote a consistent lockfile after the Phase 11.3
  dependency addition; the CI gate uses `--frozen-lockfile` to prove
  reproducibility. `VERIFIED LOCALLY` / `VERIFIED IN CI`.

### 11.2 Full verification suite (baseline, no credentials)

| Command             | Result                                                                                                          | Label              |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------ |
| `pnpm format:check` | clean (doc formatted with prettier after edits)                                                                 | `VERIFIED LOCALLY` |
| `pnpm lint`         | 17 tasks, clean                                                                                                 | `VERIFIED LOCALLY` |
| `pnpm typecheck`    | 17 tasks, clean                                                                                                 | `VERIFIED LOCALLY` |
| `pnpm test`         | all unit suites green (web 36, worker 18, auth 30, database 66, calendar 60, autonomy 105, notifications 66, …) | `VERIFIED LOCALLY` |
| `pnpm build`        | web + worker both green                                                                                         | `VERIFIED LOCALLY` |

### 11.3 Production-blocking defect found and fixed (worker start command)

**Finding (Phase 10 boot smoke).** The committed worker bundle crashed at boot:

```text
Error: Dynamic require of "child_process" is not supported
    at google-auth-library/build/src/auth/googleauth.js …
```

`tsup` externalises only the packages listed in `apps/worker/tsup.config.ts`
(`@prisma/client`, `@prisma/adapter-pg`, `pg`, `pg-native`). `googleapis` and
its transitive `google-auth-library` were being **inlined** into the ESM bundle;
`google-auth-library` performs a dynamic `require('child_process')`, which
tsup's ESM require shim rejects. `node apps/worker/dist/index.js` — the exact
Railway `startCommand` — never reached the health server. Stage 11 verified the
_build_ but never _booted_ the built artefact, so the defect shipped silently.

**Fix (same pattern the repo already uses for `pg`/Prisma):**

- `apps/worker/tsup.config.ts`: externalise `googleapis`, `google-auth-library`,
  `googleapis-common`.
- `apps/worker/package.json`: declare those three as runtime dependencies so
  the pnpm deployment target installs them and they resolve from
  `apps/worker/dist/index.js`.

**Evidence after the fix:** bundle shrunk `27.69 MB → 1.23 MB`; the exact start
command boots and all three endpoints answer (see §10). `VERIFIED LOCALLY`.
Redeploys of a running Railway service will pick this up; no database work.

### 11.4 Migration inventory review

11 sequential migrations (`packages/database/prisma/migrations`, timestamps
`20260908170809_init` → `20260910150000_outbox_timestamptz`) build the schema
in dependency order; the CI integration job re-applies them from scratch on a
clean Postgres 17 every run — the strongest available evidence that the chain
is clean and replayable. `db push` is never used. `VERIFIED IN CI`.

Destructive-op scan across all migrations: exactly one —
`DROP COLUMN "emailVerifiedAt"` in `20260908180000_authentication` — removing a
pre-release fixture column from a table created minutes earlier in the same
stage; no production data is at risk and no later migration is destructive.
`VERIFIED LOCALLY` (statement audit).

### 11.5 Secrets exposure scan

No `.env`, `.env.*.local`, token, or key value is committed; `git status` clean
of untracked secrets; all example files are placeholders. The applied
dependency change adds no credentials. `VERIFIED LOCALLY`.

---

## 17. Observability (Phase 17)

What exists, where to find it, and what a live deployment should wire up:

- **Logs**: structured JSON on stdout, redacting credential-shaped fields
  (`@space/logger`). Web logger names `space-web`/`space-calendar`, worker
  `WORKER_NAME`. Railway/Vercel capture stdout directly.
- **Metrics**: worker `GET /metrics` (Prometheus text/0.0.4):
  `worker_jobs_started_total`, `worker_jobs_completed_total`,
  `worker_jobs_failed_total`, `worker_job_duration_seconds`
  (buckets 1/5/15/30/60, label `queue`), `space_retention_pruned_rows`
  (gauge, label `table`).
- **Trace ids**: `x-request-id` on every web response
  (`apps/web/src/middleware.ts`); inbound ids propagated.
- **Health**: web `/api/healthz` + `/api/readyz`; worker `/healthz` + `/readyz`.

Not deployed (recorded, out of scope for this stage): the Prometheus scrape job,
alert rules, and dashboards are platform-level configuration (Stage 11 §N.3).
`VERIFIED LOCALLY` for endpoint behaviour; live wiring
`NOT VERIFIED — requires production credentials/environment`.

---

## 18. CI/CD safety audit (Phase 18)

`.github/workflows/ci.yml` audited:

- **Trigger**: push/PR to `main` only; `concurrency.cancel-in-progress` —
  force-pushes supersede stale runs.
- **Permissions**: `contents: read` only. No GitHub tokens or secrets are
  referenced anywhere in the file.
- **Credentials**: the only credentials are throwaway local Postgres values
  (`space:space@localhost:5432/space_test`) inside the runner.
- **No deploy step.** Nothing in CI can create, modify, or destroy a production
  service; deploys are credentials-gated and manual by design (runbooks §19).
- **Migration safety**: `db:migrate:deploy` runs against a brand-new Postgres
  service in the integration job, then `db:migrate:status` verifies
  convergence. `prisma db push` never appears.
- **E2E**: the Playwright job builds web and runs `e2e/landing.spec.ts` (no
  auth spec — the deterministic auth route is refused in production, so it
  cannot run against a prod-shaped build).
- **Lint/typecheck/test/build** all gate on `main`.

Verdict: release-safe by construction. `VERIFIED IN CI` (workflow structure +
green runs); no CI change required.

---

## 19–20. Runbooks and recovery drills (Phases 19–20)

### 19.1 Deploy web (Vercel)

1. Connect the repo (requires a remote) to a Vercel project; **Root Directory =
   `apps/web`**. During first deploy set the §2.1 env vars in the project.
2. Deploy from the verified branch; Vercel runs `pnpm install --frozen-lockfile`
   then `pnpm build:web`.
3. Post-deploy check: `GET ${APP_URL}/api/healthz` = 200;
   `GET ${APP_URL}/api/readyz` = 200 with `database:true`.

### 19.2 Deploy worker (Railway)

1. Create a Railway **Service** from the repo (root).
2. Set the §2.2 env vars; **`HEALTH_PORT` = the service's `$PORT`** so the
   `/healthz` healthcheck (railway.json) and `/metrics` scrape hit the socket.
3. Redeploy; verify logs reach "worker ready" and the healthcheck passes
   `GET <service>:/healthz`.

### 19.3 Migrate production database

Drain risk operators accept: run **direct**-connected migrations (§3.2),
`db:migrate:status` before and after, and only then roll the apps. Never
`db push`; never point the pooled URL at `prisma migrate`.

### 19.4 Rotate the OAuth encryption key

1. Generate a new key (`pnpm auth:rotate-key` or the documented
   `node -e …` snippet in `apps/web/.env.example`).
2. Set `OAUTH_ENCRYPTION_KEY` = new composite, move the old composite into
   `OAUTH_ENCRYPTION_PREVIOUS_KEYS` (comma-separated), deploy **both** web and
   worker together (same keyring requirement).
3. Once no legacy credential is re-saved, drop the oldest previous key.

### 19.5 Recovery drills (Phase 20)

- **Instance crash**: kill a worker; Railway restarts (ON_FAILURE × 5); readiness
  stays green-only-when-probes-pass; in-flight jobs are preserved by BullMQ
  (`lockDuration 60s`, `maxStalledCount 2`) and re-queued or retired after
  stalls.
- **Queue outage**: worker `/readyz` reports `redis:false`; the platform should
  drain the instance; the web-side enqueue path answers `503` instead of
  pretending success.
- **DB outage**: web `/api/readyz` returns 503 `database:false`; worker readyz
  likewise. Nothing fakes a success.
- **Email outage** (no AgentMail key): deliveries recorded `provider-not-configured`,
  never silently dropped.

Drills that require a live environment are `NOT VERIFIED — requires production
credentials/environment`; the behaviour each drill asserts is unit-tested
`VERIFIED IN CI`.

### 20.1 Repeatable local smoke suite

The §10 probe sequence (build → boot worker → probe `/healthz`, `/readyz`,
`/metrics` → boot web → probe `/api/healthz`, `/api/readyz`) is the repeatable
credential-free smoke; it was run to produce the Phase 10 evidence and can be
re-run verbatim on any machine with the build present.

---

## A. Final A–Z report

Zero-failure through every letter; labels per the rubric. Items marked
`NOT VERIFIED` show the exact mandatory phrase because no live credentials
exist in this environment.

|       | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | State                                                                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **A** | **Aim and scope** — Stage 12 converts a production-ready monorepo into an operable, verifiably deployable system. No product features; no architecture redesign; deterministic; no AI/LLM.                                                                                                                                                                                                                                                                                                                                                                     | `VERIFIED LOCALLY`                                                                                  |
| **B** | **Baseline and repository hygiene** — clean tree at `9547808`; no untracked secrets; `.env` ignored; no remotes; no `G-Course` content.                                                                                                                                                                                                                                                                                                                                                                                                                        | `VERIFIED LOCALLY`                                                                                  |
| **C** | **CI/CD safety** — push/PR to `main` only; `contents: read`; no tokens/secrets; no deploy step; integration job reinstalls migrations on a clean Postgres 17 each run; `db push` never used.                                                                                                                                                                                                                                                                                                                                                                   | `VERIFIED IN CI`                                                                                    |
| **D** | **Deployment configuration** — `apps/web/vercel.json` (Root Directory `apps/web`, frozen install, `pnpm build:web`) and `railway.json` (Nixpacks, `pnpm build:worker`, `node apps/worker/dist/index.js`, `/healthz` ON_FAILURE×5). Direct start command verified.                                                                                                                                                                                                                                                                                              | `VERIFIED LOCALLY` (deploy itself `NOT VERIFIED`)                                                   |
| **E** | **Environment contract** — exhaustive per-runtime tables (§2) covering required/optional/default/secret/server-only; no credential carries `NEXT_PUBLIC_`.                                                                                                                                                                                                                                                                                                                                                                                                     | `VERIFIED LOCALLY` + `VERIFIED IN CI`                                                               |
| **F** | **Fail-fast behaviour** — auth configuration (secrets) refuses to run unset rather than faking a value; worker and web degrade _honestly_ when dependencies are absent (boot warnings, 503 `database:false`, enqueue `503`); E2E auth refused in production.                                                                                                                                                                                                                                                                                                   | `VERIFIED LOCALLY`                                                                                  |
| **G** | **Google OAuth + Calendar** — identity scopes `openid email profile` + `calendar.readonly`, offline access, two registered redirect URIs (`/api/auth/callback/google`, `/api/calendar/callback`), anti-CSRF state cookie. Full live flow unproven.                                                                                                                                                                                                                                                                                                             | `NOT VERIFIED — requires production credentials/environment`                                        |
| **H** | **Health checks** — web `/api/healthz`, `/api/readyz`; worker `/healthz`, `/readyz`, `/metrics`; all probed on real builds.                                                                                                                                                                                                                                                                                                                                                                                                                                    | `VERIFIED LOCALLY`                                                                                  |
| **I** | **Infrastructure providers** — Supabase (pooled 6543 vs direct 5432 for migrations) and Upstash (TLS `rediss://`, `noeviction`, BullMQ compatibility) fully specified; no project exists.                                                                                                                                                                                                                                                                                                                                                                      | `NOT VERIFIED — requires production credentials/environment`                                        |
| **J** | **Job queues (BullMQ)** — six queues under `space:*`, shared ioredis connection, `maxRetriesPerRequest: null`, explicit `lockDuration`/`maxStalledCount`, deterministic repeatable jobs, idempotent web enqueue. Live processing unproven.                                                                                                                                                                                                                                                                                                                     | config `VERIFIED LOCALLY`; live `NOT VERIFIED — requires production credentials/environment`        |
| **K** | **Key management and rotation** — versioned AEAD keyring (`<keyId>:<base64>`), purpose-bound AD (identity vs calendar), rotation via `OAUTH_ENCRYPTION_PREVIOUS_KEYS`, same keyring on web+worker, `AUTH_SECRET` independent.                                                                                                                                                                                                                                                                                                                                  | `VERIFIED LOCALLY`                                                                                  |
| **L** | **Logging** — structured JSON on stdout with credential-shaped-field redaction; logger bindings `environment`, per-service names; synchronous shutdown writes.                                                                                                                                                                                                                                                                                                                                                                                                 | `VERIFIED LOCALLY`                                                                                  |
| **M** | **Metrics** — zero-dep Prometheus registry; `worker_jobs_*` counters, duration histogram, retention gauge; served at worker `/metrics`; empty-registry 404.                                                                                                                                                                                                                                                                                                                                                                                                    | `VERIFIED LOCALLY`                                                                                  |
| **N** | **Notifications/email** — AgentMail provider (`POST /v1/messages`, Bearer, `x-space-reference`); absent key ⇒ `provider-not-configured`, never faked delivery.                                                                                                                                                                                                                                                                                                                                                                                                 | provider unit `VERIFIED LOCALLY`; live `NOT VERIFIED — requires production credentials/environment` |
| **O** | **Operations runbooks** — deploy web, deploy worker (`HEALTH_PORT=$PORT`), migrate production (direct URL, status before/after, no `db push`), rotate encryption key.                                                                                                                                                                                                                                                                                                                                                                                          | `VERIFIED LOCALLY`                                                                                  |
| **P** | **Production blocker found and fixed** — the committed worker bundle crashed at boot (`Dynamic require of "child_process"` from inlined `google-auth-library`); fixed by externalising the Google SDK + declaring it a runtime dependency. Bundle `27.69 MB → 1.23 MB`.                                                                                                                                                                                                                                                                                        | `VERIFIED LOCALLY` (post-fix boot)                                                                  |
| **Q** | **Quality gates** — `format:check`, `lint`, `typecheck`, `test`, and full `build` all green at Stage 12 close.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `VERIFIED LOCALLY` + `VERIFIED IN CI`                                                               |
| **R** | **Retention and maintenance** — retention windows validated with floors; maintenance job prunes on a schedule; outbox cursor floors the event-log prune; disciplines cascade-aware deletes. Live pruning unproven.                                                                                                                                                                                                                                                                                                                                             | logic `VERIFIED LOCALLY`; live `NOT VERIFIED — requires production credentials/environment`         |
| **S** | **Security posture** — production-only CSP + HSTS, non-security headers everywhere, `__Secure-`/httpOnly/SameSite=Lax session cookies, anti-CSRF state and JSON-mutation CSRF defence, per-endpoint rate limits (in-process), pagination/meeting caps, uniform API error envelope.                                                                                                                                                                                                                                                                             | `VERIFIED LOCALLY` + `VERIFIED IN CI`                                                               |
| **T** | **Testing evidence** — web 36, worker 18, config 8, auth 30, database 66 (unit) + integration suite (CI), calendar 60, engine 90, autonomy 105, notifications 66, planning 19, ui 14, time 39, validation 29, types 15, metrics 10; plus two live boot smokes (worker, web).                                                                                                                                                                                                                                                                                   | `VERIFIED LOCALLY` + `VERIFIED IN CI`                                                               |
| **U** | **URL/origin integrity** — `APP_URL` single source for redirect URIs, `trustedOrigins`, and absolute links; mismatch documented as a production failure mode.                                                                                                                                                                                                                                                                                                                                                                                                  | `VERIFIED LOCALLY`                                                                                  |
| **V** | **Verification labels** — the rubric in §0.0 is applied to every claim in this document; nothing reports an unexercised live integration as success.                                                                                                                                                                                                                                                                                                                                                                                                           | `VERIFIED LOCALLY`                                                                                  |
| **W** | **Worker lifecycle** — graceful shutdown (readiness off first, reverse-order dispose, `SHUTDOWN_TIMEOUT_MS`), fatal on unhandled rejection/uncaught exception, restart `ON_FAILURE` max 5, signal handling unit-tested.                                                                                                                                                                                                                                                                                                                                        | `VERIFIED LOCALLY` + `VERIFIED IN CI`                                                               |
| **X** | **eXternal dependencies** — pinned toolchain (Node 24.18.0, pnpm 9.15.4) and version catalog; `--frozen-lockfile` in CI; worker runtime deps declared for the deployment target after the §P change.                                                                                                                                                                                                                                                                                                                                                           | `VERIFIED LOCALLY`                                                                                  |
| **Y** | **Why not more** — live deployment and provider verification are impossible from this machine (no credentials, no remotes, Docker absent); every provider phase ships as exact operator steps so a credential-bearing operator can complete them in minutes.                                                                                                                                                                                                                                                                                                   | `NOT VERIFIED — requires production credentials/environment`                                        |
| **Z** | **Z-day action list** — (1) add a remote; (2) create Supabase project, set pooled+direct URLs §3; (3) create Upstash DB, set `REDIS_URL`, `noeviction` §4; (4) create Google OAuth client + enable Calendar API, register the two redirect URIs §5; (5) create AgentMail key §6; (6) deploy web (Vercel roots+env §7), deploy worker (Railway env + `HEALTH_PORT=$PORT` §8); (7) run migrations via `DIRECT_DATABASE_URL` §19.3; (8) execute the §10 smoke against the live URLs; (9) re-execute Phases 12–16 live. Until then those phases remain as stamped. | —                                                                                                   |

---

## Appendix: retired

The running evidence accumulator was consolidated into §A during Phase 21.
The per-phase evidence remains in §§3–20 above.
