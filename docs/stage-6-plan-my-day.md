# Stage 6 — Plan My Day

This document records what Stage 6 built: the application service layer that
turns the deterministic Stage 5 engine into a product feature. It explains why
the web request handler and the worker queue run the **same** planning code,
how a day is persisted under the autonomy policy, and what is verified locally
versus what must run in CI.

- [A. Objective and scope](#a-objective-and-scope)
- [B. Early decisions](#b-early-decisions)
- [C. Package layout and purity boundary](#c-package-layout-and-purity-boundary)
- [D. Where planning runs: one service, two callers](#d-where-planning-runs-one-service-two-callers)
- [E. The snapshot loader](#e-the-snapshot-loader)
- [F. The day-state reader](#f-the-day-state-reader)
- [G. Lazy space creation](#g-lazy-space-creation)
- [H. The plan-service operations](#h-the-plan-service-operations)
- [I. Persistence and the autonomy policy](#i-persistence-and-the-autonomy-policy)
- [J. Optimistic concurrency: the version claim](#j-optimistic-concurrency-the-version-claim)
- [K. Idempotency and in-flight coalescing](#k-idempotency-and-in-flight-coalescing)
- [L. Error model and HTTP mapping](#l-error-model-and-http-mapping)
- [M. Web API: `POST /api/plan`](#m-web-api-post-apiplan)
- [N. Web UI: `/space` and `/space/[date]`](#n-web-ui-space-and-spacedate)
- [O. Worker refactor: one code path](#o-worker-refactor-one-code-path)
- [P. Audit events and the completed-plan payload](#p-audit-events-and-the-completed-plan-payload)
- [Q. Testing strategy](#q-testing-strategy)
- [R. Verification status](#r-verification-status)
- [S. Security review, performance and known limitations](#s-security-review-performance-and-known-limitations)

---

## A. Objective and scope

Stage 6 ships the product surface for the Stage 5 engine: a **"plan my day"
feature**. A user opens a day, clicks **Plan day**, and the engine schedules
their open tasks into the day's working hours — respecting deadlines,
dependencies, capacity and calendar events — under the autonomy level they
chose. The result is persisted, an audit trail is written, and the page
re-renders from the persisted state.

In scope:

- A new application-service package, `@space/planning`, that owns the full
  "plan this space" operation: **load → validate → run engine → persist → audit**.
  It sits between the pure engine and the web/worker entry points.
- **Lazy space creation**: a day gets a `Space` row the first time it is viewed
  or planned, keyed `(userId, date)`.
- The `POST /api/plan` route handler, the `/space` today-redirect, and the
  `/space/[date]` day page with a client-side "Plan day" button.
- **One code path for web and worker**: the worker's planning queue now imports
  the loader, persister and payload builder from `@space/planning` instead of
  re-implementing them.
- Optimistic-concurrency persistence (the version claim), autonomy enforcement
  at the persistence boundary, and the `PLANNING_COMPLETED` payload that lets
  the UI read an authoritative summary back.

Explicitly out of scope (deferred to later stages):

- **An interactive "approve these moves" flow.** The engine is already
  move-preserving under `ASK_BEFORE_CHANGING`; prompting a user to confirm
  proposed moves is UI work.
- **Preference-editing UI for planning settings.** `schedulingStrategy`,
  `autonomyLevel`, `maxDailyFocusMinutes`, `bufferMinutes` and friends are read
  from `planningPreferences` but no screen edits them yet.
- **The reminder dispatcher / outbox consumer** (Stage 7), recurrence
  expansion, and calendar writes. The audit trail this stage writes is exactly
  what those consumers will read.
- **AI** — planning remains fully deterministic; nothing in this stage invokes
  a model.

---

## B. Early decisions

| Decision                                                                        | Why                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A shared **application service** package, not a route-local script              | The web handler plans a day now and a worker job plans one later. If the two drift, a user's click and a scheduled pass disagree about what "planning" means. |
| **`@space/planning` is server-only and impure by contract**                     | Unlike the engine, it may touch the database, transactions, auth-scoped rows and the event log. It must still never import React/Next/UI.                     |
| **Composition root in the web app**, cached on `globalThis`                     | One Prisma handle, one injected clock, one logger; matches the existing `server/database.ts` / `server/clock.ts` pattern.                                     |
| Space rows are **created lazily on first view/plan**, keyed `(userId, date)`    | No separate "create space" screen, no race between view and plan; a unique composite key makes the create idempotent.                                         |
| The day view **re-reads persisted state** after planning, never trusts the POST | `router.refresh()` re-runs `getDayState`, so the page always shows what was actually written — exactly Stage 5's "read-back" guarantee.                       |
| The version claim stays **inside the persistence transaction**                  | `updateMany WHERE planVersion = loaded` is the CAS. A stale pass becomes a no-op, and the API maps it to a 409 the client can retry.                          |
| In-process **in-flight dedup** keyed `userId:spaceId`                           | Spamming "Plan day" cannot enqueue parallel passes within one process; the database CAS is the cross-process guard.                                           |
| Structured **error codes**, mapped to HTTP in the package                       | The route handler does not parse messages; one unit-testable table (`planErrorHttpStatus`) owns 400/404/409/422/500.                                          |
| A **self-contained in-memory fake database** for service tests                  | No local Postgres exists; the fake reproduces exactly the two properties the code depends on — write-ahead `$transaction` and `updateMany.count`.             |

---

## C. Package layout and purity boundary

`packages/planning/` mirrors the Stage 5 purity split but one level up:

```
packages/planning/src/
├── service.ts          createPlanSpaceService — the application service (web + worker)
├── snapshot.ts         loadPlanningInput — the whole day materialised as PlanningInput
├── day-state.ts        loadDayState / loadDayTaskPool — the authoritative read-back
├── persist.ts          persistPlanningResult — CAS claim + autonomy policy + payload builder
├── errors.ts           structured error classes with stable `code`s
├── http.ts             planErrorHttpStatus — error → HTTP status
├── types.ts            public view types (PlanSpaceResult, DayState, SpaceView, …)
├── index.ts            public exports (the worker and web import only this)
└── testing/
    └── fake-database.ts  in-memory Database stand-in used by the unit suite
```

Boundaries, enforced by typecheck + the node eslint `no-restricted-imports` rule:

- `@space/engine` stays **fully pure** (time + types only, no I/O) — unchanged
  from Stage 5.
- `@space/planning` **may** import `@space/database`, `@space/engine`,
  `@space/time`, `@space/validation`, `@space/logger`; it must **not** import
  `react`, `next` or `@space/ui`, so the worker can pull it without a web
  runtime.
- `apps/web`'s existing rule keeps `@space/config/worker`,
  `@space/database*`, `**/env.server` and `**/server/database` out of `.tsx`
  components (page/route files are exempt, as before).

The package is consumed **as source** (`exports: { ".": "./src/index.ts" }`),
the same choice Stage 5 made for the engine, and is added to `transpilePackages`
in the web app.

---

## D. Where planning runs: one service, two callers

Stage 5 left the worker with a local implementation of the loader/persister and
the web with no surface. Stage 6 removes that split:

| Caller            | Operation                                      | Entry point in `@space/planning`              |
| ----------------- | ---------------------------------------------- | --------------------------------------------- |
| Web route handler | A user clicks "Plan day"                       | `service.planSpace({ userId, date })`         |
| Worker queue      | A scheduled/enqueued `space:planning` job runs | `loadPlanningInput` + `persistPlanningResult` |

The web path wraps the lifecycle in the service (`planSpace` appends
`PLANNING_STARTED`, validates, calls the engine, persists, audits
`PLANNING_COMPLETED`/`PLANNING_FAILED`). The worker path owns only queue
mechanics — claiming a job, the stale-version pre-check, marking completion —
and delegates the snapshot, engine call and persistence to the same shared
functions. Both therefore produce **identical plans from identical state**,
which is the property that makes a retried job and a user-triggered re-plan
interchangeable.

The web composition root is `apps/web/src/server/planning.ts`: it resolves the
shared database handle, the injected clock and a `space-planning` logger once,
and caches the resulting `PlanSpaceService` on `globalThis`. Identity never
comes from here — callers pass the session's `user.id` resolved by
`server/session.ts` from the cookie.

---

## E. The snapshot loader

`loadPlanningInput` materialises the whole day as one `PlanningInput` value —
the exact contract the pure engine consumes — so a pass is reproducible and a
retry is bit-for-bit the same computation. It loads, in one `Promise.all` after
the task pool:

1. **Timezone + range** — from `userPreferences.timeZone` (default `UTC`),
   converted with `calendarDateRange` so DST is handled identically to the
   worker.
2. **Planning preferences** — duration/buffer/breaks/focus defaults,
   `schedulingStrategy`, `autonomyLevel`, weekend rules, `preferredPlanningMinute`.
3. **Existing space items** of the day (immutable anchors the engine plans
   around).
4. **The candidate task pool**: `spaceId = space` **OR** scheduled into the day
   **OR** due during the day (deadline pull-in), restricted to
   `INBOX/PLANNED/IN_PROGRESS`, de-duped by id, and **hard-capped** at
   `maxTasksPerPlan` — a pathological day fails loudly instead of thrashing.
5. **Task dependencies, calendar events, pending reminders, working hours** —
   each scoped to `userId`, calendar events excluding cancelled/deleted.

The same candidate-pool shape is shared with the day-state reader
(`loadDayTaskPool`, section F) so a view and a future pass always reason about
the same set.

---

## F. The day-state reader

`loadDayState` produces the **authoritative** `DayState` that `/space/[date]`
renders. It is read back from the database, so it can never disagree with what a
request actually persisted:

- **Timeline** — `spaces.getSpaceTimeline` returns the day's `SpaceItem`s with
  their task/reminder/calendar-event joins (via the `spaces.` namespace).
- **Calendar events are added as anchors** — the persister never creates
  SpaceItems for them, so the day view merges overlapping non-cancelled events
  directly, positioned after any planned items (`position = 1_000_000 + n`),
  and sorts by start then position.
- **Unscheduled tasks** — the candidate pool minus task ids already on the
  timeline.
- **Latest completed plan** — the newest `PLANNING_COMPLETED` event for the
  space, parsed from its payload (section P).

Because `loadDayState` is a plain function over the database, the service and
the page use it identically, and the tests assert against it after every pass.

---

## G. Lazy space creation

A `Space` row is created on first view or plan:

```ts
const row = await spaces.getOrCreateSpace(db, userId, {
  date,
  timeZone,
  status: 'DRAFT',
});
```

- Keyed by the **composite unique `(userId, date)`**, the create is idempotent:
  a simultaneous view and plan click resolve to one row, not two.
- New spaces start at `planVersion = 0` with `status = 'DRAFT'`; the first
  successful plan claims version 1 and flips the space to `ACTIVE`.
- This is why `PlanSpaceNotFoundError` exists in the API model but is
  effectively unreachable in practice: a space the caller cannot see is
  deliberately indistinct from one that does not exist, and lazy creation means
  the day always resolves.

---

## H. The plan-service operations

`createPlanSpaceService` exposes four operations:

| Operation              | Purpose                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `getToday(userId)`     | Today's date in the user's timezone (used by `/space` to redirect).                |
| `getSpaceForDate(...)` | Resolve (or lazily create) the space for a date.                                   |
| `planSpace(...)`       | One complete pass: audit → load → validate → engine → persist → audit (section D). |
| `getDayState(...)`     | The authoritative read-back a page renders (section F).                            |

`planSpace` flow:

1. Resolve the space (lazy create).
2. Coalesce in-flight duplicates for `userId:spaceId` (section K).
3. Append `PLANNING_STARTED` with a fresh `correlationId`.
4. Load the snapshot, `validatePlanningInput` (a validation failure is a
   **permanent** property of the data — surfaced as `PLANNING_CONFLICT`, never
   retried), then `plan(input, clock)`.
5. `persistPlanningResult` under the autonomy policy and version claim; a
   skipped claim becomes `PlanVersionConflictError`.
6. Append `PLANNING_COMPLETED` with the bounded payload (or `PLANNING_FAILED`,
   never masking the original error).

The result (`PlanSpaceResult`) is a joined, UI-ready view: scheduled items with
titles and priorities, unscheduled tasks with their reason codes, conflicts,
proposed actions and explanations.

---

## I. Persistence and the autonomy policy

`persistPlanningResult` enforces autonomy **at the persistence boundary**, never
in the engine — the engine always computes the best plan; the policy decides
what is worth writing.

| `autonomyLevel`        | Persistence behaviour                                                                                                                                         | `mode`                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `SUGGEST_ONLY`         | Nothing touches tasks or space items. The full pass is recorded as `AgentAction` rows with outcome `SKIPPED`, inside a transaction.                           | `suggest-only`        |
| `ASK_BEFORE_CHANGING`  | **New placements are applied**; an item already on the day is never moved. Already-placed items are skipped by item id. Proposed moves are audited `SKIPPED`. | `ask-before-changing` |
| `AUTOMATICALLY_MANAGE` | The full plan is applied; the space is marked `ACTIVE`/`plannedAt`/`optimizedAt`. Every action is audited `SUCCEEDED`.                                        | `applied`             |

Mechanics:

- `SUGGEST_ONLY` returns before the claim — it **cannot** write task or
  space-item rows by construction, so a misconfigured deployment at worst
  over-recommends.
- Full-plan application upserts each task's `SpaceItem` by its unique `taskId`
  and writes `scheduledStart`/`scheduledEnd` on the task; reminders get a
  `SpaceItem` with a start.
- `ASK_BEFORE_CHANGING` computes the set of item ids already on the day from the
  snapshot's `existingItems` and refuses to move them.
- Calendar-event blocks are **anchors**: the persister never creates rows for
  them in any mode.

---

## J. Optimistic concurrency: the version claim

The persistence transaction opens with the compare-and-swap:

```ts
const claimed = await tx.space.updateMany({
  where: { id: spaceId, userId, planVersion }, // the version the pass loaded
  data: { plannedAt: now, optimizedAt: now, planVersion: { increment: 1 }, status: 'ACTIVE' },
});
if (claimed.count === 0) return { mode, skipped: 'stale-version' };
```

- `updateMany` returns a **count**: exactly one concurrent pass can win the
  claim; the loser observes `count = 0` and the whole transaction aborts having
  written nothing.
- Everything else — space items, task schedule fields, agent actions — commits
  atomically with the claim, so a mid-transaction failure rolls back the entire
  pass (pinned by test).
- Because the engine is pure, a retried job computes the **same** plan, so
  re-application after an idle retry is a no-op; the claim is what makes
  idempotency structural rather than handled.
- The API maps a lost claim to `409` ("The day changed while it was being
  planned. Try again."), and the client can re-click.

The worker additionally pre-checks the version when it loads the job
(`space.planVersion !== planVersion` → early `{ success: true, skipped:
'stale-version' }`), so a stale queued job never even loads a snapshot.

---

## K. Idempotency and in-flight coalescing

In one process, rapid duplicate clicks are coalesced:

```ts
const key = `${userId}:${space.id}`;
const existing = inFlight.get(key);
if (existing) return existing;
const pending = runPlan({ userId, space });
inFlight.set(key, pending);
// …removed on settle
```

- The map lives on the cached service instance, so all requests in the process
  share it. Two identical clicks resolve to the **same** pending pass (asserted
  `first === second`), and exactly one `PLANNING_COMPLETED` is written.
- Across processes/instances the database version claim is the source of truth
  (section J); a loser sees `409` instead of corrupted state.
- Re-planning an already-planned day is an explicit, deterministic act: the next
  click loads the current version and claims the **next** revision, advancing
  `planVersion` 0 → 1 → 2… (pinned by test) — never a clobber of newer state.

---

## L. Error model and HTTP mapping

`errors.ts` defines five structured errors, each carrying a stable machine
`code` so an API boundary never parses messages:

| Error                      | `code`                  | Meaning                                                       | HTTP |
| -------------------------- | ----------------------- | ------------------------------------------------------------- | ---- |
| `PlanInvalidDateError`     | `INVALID_DATE`          | Not a well-formed `YYYY-MM-DD`                                | 400  |
| `PlanSpaceNotFoundError`   | `SPACE_NOT_FOUND`       | Space unresolvable (kept for API completeness; lazy creation) | 404  |
| `PlanVersionConflictError` | `PLAN_VERSION_CONFLICT` | Space changed under the pass; nothing written                 | 409  |
| `PlanInputInvalidError`    | `PLANNING_CONFLICT`     | Loaded snapshot violates engine invariants; no plan possible  | 422  |
| `PlanFailedError`          | `PLANNING_FAILED`       | Internal failure while planning; details stay server-side     | 500  |

`planErrorHttpStatus(error)` lives in the package (`http.ts`) so it is
unit-testable without a web harness; unknown errors default to `500`. Note the
deliberate audit asymmetry: a **version conflict** is a legitimate race, so it
appends no `PLANNING_FAILED` event; an invalid input and internal failures do,
because an operator should always see the last thing a pass attempted.

---

## M. Web API: `POST /api/plan`

`apps/web/src/app/api/plan/route.ts`:

- **Auth**: `getOptionalUser()`; no session → `401 { error: 'Authentication
required.' }`. The route never accepts an identity from the body.
- **Body**: `{ date: "YYYY-MM-DD" }`; malformed JSON or a non-calendar date →
  `400`. The date is passed onward as a branded `CalendarDate`.
- **Execution**: `planSpace({ userId: context.user.id, date })` on the cached
  service.
- **Success**: a bounded summary — `planVersion`, `mode`, `applied`, counts of
  scheduled/unscheduled — never the full plan (the page re-reads persisted
  state instead).
- **Failure**: `planErrorHttpStatus` + a fixed, client-safe message per status
  (no internals, no stack, no dynamic user data).

There is deliberately **no `GET /api/plan`**: the page owns reading, via the
server component's `getDayState`; a GET that recomputes would duplicate the
persistence path and invite caching bugs.

---

## N. Web UI: `/space` and `/space/[date]`

**`/space`** (`space/page.tsx`) — resolves the session
(`requireOnboardedUser`), computes today in the user's timezone via
`service.getToday(userId)`, and server-redirects to `/space/<today>`. The date
is derived server-side, never taken from the client.

**`/space/[date]`** (`space/[date]/page.tsx`) — **Next.js 16**: `params` is a
Promise, awaited; a non-calendar date calls `notFound()`. The page is
`force-dynamic` and renders the server component `DayView` with the
`DayState` returned by `service.getDayState(...)`. It also secretes the
`AuthHeader`.

**`DayView`** (`components/plan/day-view.tsx`) — a presentation-only Server
Component. It renders:

- The friendly date, revision number and `PlanMode` label ("Applied" /
  "Suggestions only" / "Preview only"), plus the timezone when non-UTC.
- Prev / Today / Next navigation across dates using `@space/time`.
- The **timeline**: each item shows its local start–end and title; calendar
  events use a distinct `border-border-strong bg-muted` treatment with an
  `event` tag so anchors are visually obvious.
- The **unscheduled** list with estimated durations.
- A **conflicts** section when the latest completed plan reported any.
- Styling from existing design tokens only (`background`/`surface`/`foreground`
  /`muted`/`border`/…); no red/destructive token exists — errors render in
  `text-muted-foreground`.

**`PlanDayButton`** (`components/plan/plan-day-button.tsx`) — the single client
control. It POSTs `/api/plan` with the page's date, disables itself while
flying (`Planning…`), shows the server's message on failure, and on success
calls `router.refresh()` so the page re-runs `getDayState` — the rendered day,
not the POST response, is the source of truth.

---

## O. Worker refactor: one code path

`apps/worker/src/queues/planning-worker.ts` is now deliberately thin:

- It imports `loadPlanningInput`, `persistPlanningResult` and
  `buildPlanningCompletedPayload` (plus the `PlanMode` type) from
  `@space/planning`; the local copies of those functions were deleted.
- It owns the queue mechanics: `Worker<PlanningJobPayload>` on `space:planning`,
  the stale-version pre-check on load, `concurrency: 2`, and a limiter of 10
  jobs per 60 s.
- The web request handler and the worker now run the **same** snapshot load,
  the **same** engine invocation and the **same** autonomous persistence, so a
  scheduled pass and a manual click cannot diverge.

The worker's `package.json` gains `@space/planning`; its build (`tsup`) and the
web build both compile the new package from source.

---

## P. Audit events and the completed-plan payload

A planning pass emits exactly one lifecycle event under
`aggregateType: SPACE, aggregateId: spaceId`, tied by `correlationId`:

| Event                | Emitted when                              | Payload highlights                                                 |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `PLANNING_STARTED`   | the pass begins (service or worker)       | —                                                                  |
| `PLANNING_COMPLETED` | persistence succeeded (any mode)          | mode, counts, conflicts, explanations, `planVersion`, `durationMs` |
| `PLANNING_FAILED`    | any failure other than a version conflict | truncated message (500 chars)                                      |

Every engine decision additionally lands as one `AgentAction` row per proposed
action, with `outcome` (`SUCCEEDED` or `SKIPPED` per autonomy), `reason`,
`factors`, `previousState`/`resultingState`, `correlationId` and `durationMs` —
the full deterministic trail from which `listAgentActionsForSpace` can
reconstruct why a day looks the way it does.

`buildPlanningCompletedPayload` builds the `PLANNING_COMPLETED` payload, and
`planningCompletedPayloadSchema` (a zod schema) validates it. The payload is
**deliberately bounded** — conflicts capped at 50, explanations at 100, factors
dropped — both to keep the event row small and because a PLANNING_COMPLETED
event must always parse, even after future engine versions add new reason codes
(types are kept as free strings in the schema and narrowed at the read boundary
in `day-state.ts`). This is exactly what `loadLatestCompletedPlan` reads back to
power `DayState.latestPlan`.

---

## Q. Testing strategy

The unit suite runs entirely offline, including a **self-contained fake
database** (`testing/fake-database.ts`) because the repository has no local
Postgres.

**The fake database.** It reproduces precisely the two properties `@space/planning`
depends on from Prisma: `$transaction` is **write-ahead** (the work runs against
a clone of the store; only a resolving callback replaces the real store, so a
throw rolls the whole unit of work back), and `updateMany` returns a `count`
(the CAS key). It implements the query surface the loader/persister/reader
actually use — equality, `OR`, `in`, range operators, `not`, composite keys,
single-level `include` (task/reminder/calendarEvent), `orderBy`, `take` — with
`space.planVersion` defaulting to 0, auto sequence on `eventLog`, and default
ids like `fake-row-N` long enough (≥ 8 characters) to satisfy the audit
repository's `aggregateId` validation. An injection seam (`onWrite(model,
method)`) lets a test force a mid-transaction failure.

**`service.test.ts` — 17 tests**, all against a fixed `2026-03-30` (Monday,
Europe/Lisbon) with seeded working hours and a fixed injected clock:

- **Lazy creation & empty day**: first plan creates the space and reaches
  revision 1; read-back shows `ACTIVE`, planVersion 1, empty timeline.
- **Scheduling**: an open task lands inside working hours with the correct
  duration; a task with no availability is reported unscheduled; a hard
  deadline is met (block ends ≤ due); tasks stay out of calendar blocks.
- **The day view**: an overlapping calendar event appears in the authoritative
  timeline.
- **Ownership**: only the requesting user's tasks are ever planned.
- **Autonomy**: `SUGGEST_ONLY` writes nothing and records every action
  `SKIPPED`; `ASK_BEFORE_CHANGING` leaves existing placements untouched while
  applying new ones; `AUTOMATICALLY_MANAGE` applies and audits `SUCCEEDED`.
- **Concurrency**: duplicate in-flight clicks coalesce into one pass
  (`first === second`, one completed event); a re-plan advances to revision 2;
  a stale pass (version moved underneath) observes `skipped: 'stale-version'`
  without writing; a write-hook failure mid-transaction rolls everything back
  and emits `PLANNING_FAILED`.
- **Validation & dates**: `INVALID_DATE` on malformed dates; `PLANNING_CONFLICT`
  on structurally invalid working hours; `getToday` rolls over at a
  mid-UTC-day instant for Lisbon (`23:30Z` → the 31st) versus UTC (the 30th).

**`http.test.ts` — 2 tests**: every error code maps to its status (400/404/409/
422/500), and unknown errors (plain `Error`, string, null) map to 500.

---

## R. Verification status

All repo-wide checks are green:

```
pnpm lint         → 14/14 tasks successful   (new packages @space/planning included)
pnpm typecheck    → 14/14 tasks successful
pnpm test         → 13/13 tasks successful   (@space/planning: 19 tests — 17 service + 2 http)
pnpm build        → 3/3 tasks successful     (web + worker; /api/plan, /space, /space/[date] shipped)
pnpm format:check → all files Prettier-clean
```

`next build` (Turbopack, Next 16.3.4) compiled successfully and route-pruned the
new surface: `/api/plan`, `/space` and `/space/[date]` are `ƒ (Dynamic)` — no
pre-render requires a database or session at build time, and the existing
`getOptionalUser` try/catch keeps the static landing page prerenderable.

**Not verifiable locally** (runs in CI, as in Stage 5):

- **Postgres-backed integration** — the `@space/database` integration suite and
  `prisma migrate deploy` need a real database (docker-compose supplies one in
  CI). The planning package's database code is validated here by typecheck +
  lint + the fake-database suite.
- **BullMQ execution** — the worker's Redis-backed queue and job lifecycle needs
  Redis. The planning worker was validated offline (typecheck, lint, build).
- **Playwright E2E** (`apps/web/e2e`) and the **Google-calendar OAuth flows**
  need a running app, a database and provider credentials; they remain CI-owned.

---

## S. Security review, performance and known limitations

### Security review

- **Identity only from the session.** `planSpace`, `getDayState` and the route
  handler accept `userId` from `getOptionalUser`/`requireOnboardedUser` —
  resolved from the cookie, never from the browser. Every query and every write
  is scoped `(userId, …)` (and the claim is scoped `(id, userId)`), so a job
  payload carries no authority beyond the pair.
- **`SUGGEST_ONLY` cannot write by construction.** It returns before the
  transaction; a misconfigured deployment at worst over-recommends.
- **Bounded error and payload output.** Messages visible to the client are
  fixed strings; `PLANNING_FAILED` payloads truncate at 500 chars; the completed
  payload is capped (50 conflicts / 100 explanations) and carries no
  credentials. The correlated seed ids and `correlationId` are server-generated
  — no untrusted string is stored un-bounded.
- **Privacy of reads.** `getDayState`/`loadDayState` read through the same
  scoped repositories, so one user can never observe another's day.

No High-severity findings.

### Performance considerations

- The full operation is three bounded database round-trips (space upsert +
  typed loader in one `Promise.all` + single transaction) plus a pure engine
  call that is O(tasks × slots × edges) on a cap-capped pool.
- The version claim is one indexed `updateMany`; a `409` for a racing pass costs
  the caller nothing persistent.
- `$transaction` covers the whole write unit, so partial plans can never leak
  into the day view; the read-back is a small set of indexed per-user queries.
- In-process coalescing bounds concurrent passes per service instance to one per
  space.

### Known limitations and deferred work

1. **Database-backed and queue paths unverified locally.** No local
   Postgres/Redis, so the loader/persister and the BullMQ job lifecycle are
   validated by typecheck, lint, build and the offline fake-database suite;
   integration and E2E run in CI.
2. **`ASK_BEFORE_CHANGING` has no confirm UI.** The engines and persister
   already refuse to move existing placements; prompting a user to approve the
   proposed moves is UI work.
3. **No planning-settings editor.** `schedulingStrategy`, `autonomyLevel`, focus
   caps, buffers and weekend rules are honoured from `planningPreferences` but
   not yet editable anywhere.
4. **Cadence/automatic replanning is not wired.** A user triggers a pass by
   clicking; the queue exists and is shared code, but no scheduler enqueues
   `space:planning` jobs yet.
5. **Reminder dispatcher, outbox consumer, recurrence expansion and calendar
   writes remain deferred** — the audit trail this stage writes is exactly the
   input those (Stage 7) consumers are designed to read.
6. **README remains stale** at "Stage 03 — Identity" (unchanged since Stage 5;
   out of scope here).
