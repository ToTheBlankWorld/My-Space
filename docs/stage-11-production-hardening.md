# Stage 11 — Production Hardening, Reliability & Observability

This document records what Stage 11 built: the conversion of the Stages 1–10
platform into something that can be operated, scaled and survived failure in
production. Deterministic, explainable, no AI/LLM anywhere — exactly like every
stage before it.

- [A. Objective and scope](#a-objective-and-scope)
- [B. Design principles](#b-design-principles)
- [C. Database hardening](#c-database-hardening)
- [D. Calendar provider pagination and caps](#d-calendar-provider-pagination-and-caps)
- [E. Data retention](#e-data-retention)
- [F. Web API security](#f-web-api-security)
- [G. Request IDs and health endpoints](#g-request-ids-and-health-endpoints)
- [H. Worker queue hardening](#h-worker-queue-hardening)
- [I. Metrics and observability](#i-metrics-and-observability)
- [J. Dead code removal](#j-dead-code-removal)
- [K. Deployment and environment](#k-deployment-and-environment)
- [L. Testing](#l-testing)
- [M. Verification](#m-verification)
- [N. Known limitations and future work](#n-known-limitations-and-future-work)

---

## A. Objective and scope

Each earlier stage shipped capability: calendars, the engine, Plan My Day,
notifications, the autonomous loop, the premium product surface. Stage 11 makes
that capability **safe to run unattended**. Every service — the web app, the
worker, the database and the queues — gets the reliability plumbing that the
platform would otherwise lack on day one of a real deploy:

In scope:

- **Database hardening** — a monotonic outbox cursor that slips forward even
  when outbox events are missing or out of order, an honest commit-timestamp
  representation of the log, and compare-and-swap synchronization primitives so
  two consumers can never double-apply the same event.
- **Calendar provider pagination and caps** — Google sync now walks every page
  rather than trusting the first response, and caps events, pages and calendars
  so a pathological calendar cannot starve sync or blow the database.
- **Data retention** — the event log, agent actions, notifications, email logs,
  expired sessions and verifications, and calendar-event tombstones are pruned
  on a schedule by a maintenance job, with safe floors and CASCADE-aware delete.
- **Web API security** — JSON-mutation CSRF defense, per-user per-endpoint rate
  limits, a uniform API error envelope, and a production-only CSP + HSTS.
- **Request IDs and health endpoints** — every response carries `x-request-id`;
  the web app exposes `/healthz` and `/readyz` (with a real database probe).
- **Worker queue hardening** — explicit lock durations and stall counts, failure
  logging on every worker, no wasted retries on permanent validation errors,
  and correct stale documentation.
- **Metrics** — a zero-dependency Prometheus exposition served by the worker,
  covering job throughput/latency and retention prunes.
- **Dead code removal** — a feedback-loop cycle counter that computed nothing
  is gone.
- **Deployment** — committed Vercel and Railway configuration, and an
  environment/secrets inventory for operators.
- **This document.**

Explicitly out of scope:

- **AI/LLM-generated anything.** No model is called; nothing here is generative.
- **New product capability.** Stage 11 adds no planning, calendar, notification
  or autonomy behavior the user sees. It hardens what exists.
- **Horizontal scaling of the API.** The web rate limiter is in-process per
  instance; scaling it horizontally without a shared store is a deliberate
  trade, recorded in [Section N](#n-known-limitations-and-future-work).
- **A Prometheus server and dashboards.** Stage 11 ships the exposition and the
  scrape route, not the monitoring deployment itself.

---

## B. Design principles

1. **Fail loudly, fail honestly.** Endpoints return JSON errors with real status
   codes; `/readyz` answers 503 when a dependency is down; an unconfigured
   `/metrics` returns 404 rather than scraping an empty stream.
2. **Health ≠ liveness.** `/healthz` never pings the database — a database outage
   should stop the app _taking work_, not make the platform restart the process.
3. **Unauthenticated surfaces leak nothing.** Health payloads report names and
   `ok` flags only; never the _reason_, host names, or driver errors.
4. **Writes are cheapest to reject before they happen.** Origin checks, rate
   limits and JSON parsing all run _before_ a mutation touches the database.
5. **Permanent failures are not retried.** Retries exist for transient faults.
   A validation error is permanent and is recorded as such.
6. **Observability by construction.** Request IDs, job metrics and retention
   gauges are attached at the composition root, not sprinkled through business
   logic.
7. **Determinism.** Every executable path here is pure logic, unit-tested with
   injected clocks, memory-allocation-free of nondeterminism, and explainable.

---

## C. Database hardening

Covers `packages/database`: migration `20260910150000_outbox_timestamptz` plus
two repository additions.

### C.1 Monotonic outbox cursor (`commitOutbox`)

`commitOutbox` previously assumed outbox events arrive **and are stored** in
sequence order. A batch can in practice contain events whose backing event-log
rows have later sequence numbers than their peers — reporting the last event in
the batch as the cursor then _replayed_ skipped rows, and reporting the max
`sequence+1` could skip rows **not yet written**, breaking a consumer that
shuts down mid-batch.

The new contract is monotonic and shutdown-safe: the committed cursor is the
maximum sequence among **already-persisted** event-log rows for this batch. If
an event is still unwritten, its sequence is never committed, so a crash cannot
silently skip it. The commit now also fails loudly (_not_ a silent partial) if
two batches race on the same outbox group (a unique partial index backs the
`BatchContext` strategy).

### C.2 Monotonic log timestamps (`linearsummaryLatest` / cursor output)

The previous `occurredAt`-based cursor bound could go backwards: an event
written with a stale clock could carry a timestamp below the cursor, and the
standard delta-encoding in the log would then emit signed/nonsensical deltas.

Repositories now:

- clamp an event's stored `occurredAt` to _never_ regress a cursor once flushed;
- keep the cursor `sequence`-based (the log is linearised by `sequence`, and
  cursor reads always take `sequence > cursor` with an `occurredAt >= floor`
  guard rather than a single timestamp comparison).

Merged with the outbox monotonicity, this guarantees: any event the log
delivers is **never** an event an outbox batch already committed, and a lagging
consumer can always catch up.

### C.3 Compare-and-swap (`casSabotage`, `synchronised`)

Cross-process command handlers (defense task discovery, calendar sync reset)
previously did blind-write updates ("set the deadline"; "mark cancelled").
Under a second node the last writer won without ever knowing it. Two new
CAS-style helpers, `casSabotage` and `synchronised`, implement the
read-compare-write with a bounded retry loop and an explicit `already-in-state`
result, so a handler that lost the race records it instead of clobbering the
state.

All three grind on integration tests in
`packages/database/src/__tests__/integration/` (they need a real Postgres; see
[Section M](#m-verification)).

---

## D. Calendar provider pagination and caps

`packages/calendar` previously paged through the Google API but was capped by
an isolation bug: cursor-driven pagination produced a fixed `pageToken`, so
forces larger than one page yielded only the last page.

Now:

- **Authentic pagination loops.** Each provider call walks `nextPageToken` until
  exhausted (with a hard page cap), aggregating events across pages.
- **Provider caps** (`EVENTS_PER_SYNC: 2000`, `PAGES_PER_SYNC: 20`,
  `CALENDARS_PER_ACCOUNT: 50`) bound a single sync pass, and the loop stops with
  a clear `cap-reached` outcome instead of silently truncating.
- The counters the cap checks are **shared, mutable** through the pagination
  helpers, not re-read from a response, so a page can never inflate the budget.

Unit tests cover: truncation to the event cap across many pages, a dominant
calendar being capped while page budgets remain, per-calendar iteration honouring
the calendar cap, and a provider that returns the same token twice terminating
instead of spinning.

---

## E. Data retention

### E.1 Repository (`packages/database/src/repositories/retention.ts`)

`runRetention` performs a full prune pass in one call for the maintenance job
to invoke, returning per-table `DeleteResult`s. Prunes operate table-by-table
with **CASCADE-aware ordering** and decide between bulk `deleteMany` (when a
table has no on-delete-cascade children) and a pre-fetch/`in` delete (when it
does). A cursor argument ports noisy paging reads backward for outer loopers
(`pruneCalendarEventTombstones`), so a large table is drained a chunk at a time
rather than one unbounded delete.

### E.2 The maintenance job

`apps/worker/src/queues/maintenance-worker.ts` consumes `space:maintenance`
jobs. Its only task, `prune-retained-data`, calls `runRetention` with windows
from worker env, logs the counts per job on the worker logger, and records them
on the metrics gauge (`space_retention_pruned_rows`). It is scheduled by
`scheduleMaintenance` on an interval from worker env (default once a day,
minimum hourly).

### E.3 Safety floors

- The event-log window is additionally bounded below by the smallest committed
  outbox cursor, so pruning can never break a lagging consumer.
- Retention windows are validated in `@space/config/worker` (`min 7 days` for
  the logs, `min 1` for sessions and verifications, `min 60` minutes for the
  schedule), so a misconfiguration cannot silently wipe history.

---

## F. Web API security

### F.1 Uniform API envelope (`apps/web/src/lib/http.ts`, `apps/web/src/server/api.ts`)

- `jsonError(message, status)` and `readJsonBody` (which _parses_ instead of
  throwing) give every route one shape.
- `ApiError(status, message)` + `withApi(handler)` wrap every API route:
  thrown `ApiError`s become `{ error: message }` with the right status, Next's
  control-flow digests (`NEXT_REDIRECT`/`NEXT_NOT_FOUND`) are rethrown, and
  unhandled errors return a neutral 500 — with the `x-request-id` attached to
  both the response and the logged error so the operator can correlate.

### F.2 Origin check

`classifyOrigin(request)` returns `same-origin | cross-origin | absent`.
**Mutations** require same-origin or absent; `cross-origin` gets a 403 before
any business logic runs. Combined with the JSON-only content type and a
SameSite cookie, this closes CSRF against JSON mutations. Absent-origin
requests (server-to-server, Postman) remain allowed: they hold no ambient
browser credentials.

### F.3 Rate limiting (`apps/web/src/server/rate-limits.ts`)

A fixed-window `WebRateLimiter` (evicting window map, injected clock) guards
expensive or brute-forceable endpoints behind `spendRateLimit(scope, userId)`:

| Scope                | Window | Limit |
| -------------------- | ------ | ----- |
| `plan`               | 60 s   | 10    |
| `notificationRead`   | 60 s   | 60    |
| `calendarConnect`    | 60 s   | 10    |
| `calendarSync`       | 60 s   | 20    |
| `calendarDisconnect` | 60 s   | 10    |

429 responses use the standard `Retry-After` semantics—the envelope carries the
`x-ratelimit-*` headers on every `withApi` response. It is in-process per
instance: a deliberate, documented trade for a single-instance deploy.

### F.4 CSP and HSTS (`apps/web/next.config.ts`)

`securityHeaders` (X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
Permissions-Policy, CSP on HTML) are **always** on. The strict CSP and HSTS
(`max-age` 1 year, `includeSubDomains`) are production-only, because the
development hot-reload pipeline needs inline scripts and the local `http://`
origin can never carry a preload-safe HSTS header.

Every API route refactored through the envelope in this stage:

`/api/plan`, `/api/notifications`, `/api/notifications/read`,
`/api/calendar/connection`, `/api/calendar/sync`,
`/api/calendar/disconnect`, `/api/calendar/calendars`, `/api/calendar/status`.

---

## G. Request IDs and health endpoints

### G.1 Request IDs (`apps/web/src/lib/request-id.ts`, `apps/web/src/middleware.ts`)

- Every response to a non-asset request carries `x-request-id` (UUID).
- An inbound request ID is **accepted only if** it is ≤ 128 chars and matches
  `[A-Za-z0-9._:-]+`, so a client can correlate a frontend error all the way to
  the browser — without giving a reflectable injection surface.
- `withApi` logs unhandled errors with that same ID, which is what makes the
  error envelope in [Section F.1](#f1-uniform-api-envelope) actionable.

### G.2 `GET /api/healthz` and `GET /api/readyz`

- `/healthz` is liveness only: 200, `{ status: "ok", service: "web",
uptimeSeconds }`, `no-store`.
- `/readyz` runs a real database probe (`SELECT 1` through Prisma) and answers
  200 `{ status: "ready" }` or 503 `{ status: "degraded", dependencies:
{ database: false } }` — never _why_, never the driver error. This is the
  payload a load balancer should use to stop routing to a web instance whose
  database is gone.

### G.3 Worker health (`apps/worker/src/health/server.ts`)

The worker runs its own small HTTP server (default port 8080,
`HEALTH_PORT`) with the same liveness/readiness split plus `GET /metrics`.
Readiness probes are an injected list (database, Redis) that report
`{ name, ok }` only. Liveness never runs probes.

---

## H. Worker queue hardening

- **Explicit reliability options** (`WORKER_OPTIONS` in
  `apps/worker/src/queues/index.ts`): `lockDuration: 60_000`,
  `maxStalledCount: 2` — applied on every worker instead of BullMQ defaults.
- **Failure logging on every worker** via `attachFailureLogging`: the `failed`
  event is logged with the error so a queue that exhausts retries is loud, not
  silently parked.
- **Planning validation is permanent.** In `planning-worker.ts` a request that
  fails validation used to throw (3 retries × the ceiling), wasting queue time
  on a request that can never become valid. It now records a `PLANNING_FAILED`
  audit with `reason: "validation"` and returns `{ failure: "validation" }`.
- **Stale documentation fixed.** `queues/index.ts` claimed each queue had its
  own Redis connection; all queues in fact share one connection (which is the
  correct BullMQ topology). The comment now says so.
- The notification worker keeps its delivery dead-letter finalize handler:
  undeliverable messages are recorded, not silently dropped.

---

## I. Metrics and observability

### I.1 `@space/metrics` — a zero-dependency registry

A tiny Prometheus-text registry (`createMetrics`) with counters, gauges and
histograms, `render()` to Prometheus text format (0.0.4), and a flat
`snapshot()` for tests. Zero dependencies by design; it ships only what the
worker needs.

- Unit tests (`packages/metrics/src/__tests__/metrics.test.ts`, 10) cover
  counter/gauge/histogram behavior, label handling, `observe` distribution and
  rendering.

### I.2 Worker wiring

- `attachJobMetrics(worker, metrics, queueName)` in `queues/index.ts` exposes
  `worker_jobs_{started,completed,failed}_total` and a
  `worker_job_duration_seconds` histogram (buckets 1…60), so both a slow queue
  and a recovering one are visible.
- `maintenance-worker.ts` exposes `space_retention_pruned_rows` with a `table`
  label (event_logs, agent_actions, notifications, email_logs, sessions,
  verifications, calendar_events).
- `apps/worker/src/index.ts` creates the registry once, attaches it to all five
  workers (planning, calendar-sync, notifications, autonomy-review,
  maintenance), and hands `metrics.render()` to the health server. `GET
/metrics` serves it `text/plain; version=0.0.4`, `no-store`.

---

## J. Dead code removal

`packages/autonomy/src/feedback-loop.ts` contained a first "alternation
counting" loop that computed a `lastWasReplan`/`cycles` pair and then discarded
it entirely — `cycles` was never incremented there and `lastWasReplan` was never
read. The (working) simplified replan→user-change→replan detection that followed
was the only logic in use. The dead loop is removed.

---

## K. Deployment and environment

### K.1 Committed configuration

- `apps/web/vercel.json` — Vercel: `framework: nextjs`, `installCommand: pnpm
install --frozen-lockfile`, `buildCommand: pnpm build:web` (set the Vercel
  project Root Directory to `apps/web`).
- `railway.json` — Railway worker service: Nixpacks build with
  `buildCommand: pnpm build:worker`, `startCommand: node
apps/worker/dist/index.js`, healthcheck on `/healthz` with an
  `ON_FAILURE` restart policy (max 5 retries).

> Railway injects `$PORT`. Set `HEALTH_PORT` to that value on the service so
> the health check (and Prometheus scrape on `/metrics`) hits the listening
> socket. Vercel requires no port handling.

### K.2 Environment and secrets inventory

The platform reads configuration as documented in `docs/authentication.md`,
`docs/database.md` and the `@space/config` schemas. The production-relevant set:

| Variable                                                                                               | App                             | Where                | Secret? |
| ------------------------------------------------------------------------------------------------------ | ------------------------------- | -------------------- | ------- |
| `DATABASE_URL`, `DIRECT_DATABASE_URL`                                                                  | web, worker                     | Railway PG, Vercel   |
| `REDIS_URL`                                                                                            | web, worker                     | Redis provider       |         |
| `WORKER_NAME`                                                                                          | worker (default `space-worker`) |                      |         |
| `HEALTH_PORT`                                                                                          | worker (default 8080)           | Railway service port |         |
| `AUTH_SECRET`                                                                                          | web                             | Vercel env           | yes     |
| `OAUTH_ENCRYPTION_KEY` (+ `OAUTH_ENCRYPTION_PREVIOUS_KEYS` during rotation)                            | web, worker                     |                      | yes     |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                                             | web, worker                     |                      | yes     |
| `AGENTMAIL_API_KEY`, `AGENTMAIL_BASE_URL`                                                              | worker                          |                      | yes     |
| `APP_URL`                                                                                              | web, worker                     |                      |         |
| `NEXT_PUBLIC_APP_URL`                                                                                  | web                             |                      |         |
| Retention/schedule intervals (`*_RETENTION_DAYS`, `*_INTERVAL_MINUTES`, `PLANNING_MAX_TASKS_PER_PLAN`) | worker                          |                      |         |

Rules recorded across stages and upheld here:

- **Never** hardcode or commit these. `.env.local`/`.env` are git-ignored;
  `apps/web/.env.example` and `.env.example` document shape only.
- OAuth keys use the documented rotation format (`<keyId>:<key>`); the worker
  and web share the same keyring so stored tokens decrypt everywhere.
- Provider credentials (Google OAuth, AgentMail) are optional at boot: the
  worker logs `configured: false` (never the value), routes return honest
  unauthenticated/"provider-not-configured" errors, outbound email attempts are
  recorded as failed rather than fake-delivered.
- In CI, only throwaway credentials exist: GitHub Actions service Postgres
  (`space:space@localhost:5432/space_test`) — no real secret ever lives in
  `.github/workflows/ci.yml`.

---

## L. Testing

Stage 11 carries a "every functional fix earns a real test" rule. New unit
tests in this stage:

- `packages/database` integration (outbox monotonicity, CAS primitives,
  retention prunes) — run with a real Postgres via `TEST_DATABASE_URL`
  (`pnpm test:integration`).
- `packages/calendar` pagination caps (multi-page truncation, cap interactions,
  repeated-token termination).
- `apps/web/src/lib/http.test.ts` — `jsonError`, `readJsonBody`, and
  `classifyOrigin` across same/cross/absent origins.
- `apps/web/src/server/rate-limits.test.ts` — fixed-window limiter with an
  injected `FixedClock`: burst rejection, window reset, per-key isolation,
  expiry eviction.
- `apps/web/src/lib/request-id.test.ts` — UUID generation, well-formed inbound
  accept, malformed/oversize inbound rejection, fresh-ID fallback.
- Worker health-route behavior is covered directly in
  `apps/worker/src/__tests__/health-server.test.ts`: it now asserts
  `/metrics` serves rendered Prometheus text and returns 404 when no registry
  is configured — plus the pre-existing liveness/readiness/probe-leak tests.
- `packages/metrics` — registry, counters, gauges, histograms, rendering.

`Rule`: remediation code paths are exercised by tests that fail before the fix
and pass after; no test was added to satisfy coverage.

---

## M. Verification

Full deterministic verification (PowerShell; no live credentials locally):

| Command                 | Result                                    |
| ----------------------- | ----------------------------------------- |
| `pnpm format:check`     | clean                                     |
| `pnpm lint`             | clean across all workspaces               |
| `pnpm typecheck`        | clean across all workspaces               |
| `pnpm test`             | unit suites all green                     |
| `pnpm build`            | all workspace builds + `next build` green |
| `pnpm test:integration` | requires real Postgres — exercised in CI  |

Local unit numbers at the close of Stage 11: web 36, worker 18, metrics 10,
autonomy 105, plus the calendar/database/planning/notification/engine/time/auth
package suites. Integration and Playwright suites run in CI
(`.github/workflows/ci.yml`: lint, typecheck, test, build, format; a Postgres
service job for migrations + integration; a Playwright job for e2e).

---

## N. Known limitations and future work

1. **In-process rate limiting.** The web limiter is per-instance memory. On a
   single deploy target it is exact; horizontally scaled, an attacker gets N×
   the budget. Moving to Redis token buckets is the documented next step.
2. **No shared store for the web `ApiError` envelope.** Errors are JSON-only by
   design; API _consumption_ from native clients is a future web surface.
3. **Prometheus target config and dashboards** are not deployed; `/metrics`
   exists and is scrape-ready, but the scrape job and alert rules are
   platform-configured outside this repo.
4. **Maintenance lag.** Retention prunes run on the worker's schedule; if the
   worker is down they queue, but no secondary trigger exists.
5. **Health endpoints are unauthenticated.** Correct for load balancers and
   probes, but they add a small information surface (service identity,
   dependency booleans); an egress-firewalled / restricted network is assumed.
6. **Next.js middleware deprecation.** Next 16 warns that the `middleware` file
   convention (`apps/web/src/middleware.ts`) is deprecated in favor of a
   `proxy` file. The build is green and the behavior identical; migrating the
   file to the new convention is a mechanical follow-up.
