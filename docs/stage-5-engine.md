# Stage 5 — The deterministic Space Engine

This document records what Stage 5 built, why it is shaped the way it is, what
is verified and what is deliberately not verified yet. It is the engineering
report for the scheduling engines shipped on top of the Stage 4 baseline.

- [A. Objective and scope](#a-objective-and-scope)
- [B. Early decisions](#b-early-decisions)
- [C. Data model and migrations](#c-data-model-and-migrations)
- [D. The engine package and purity rules](#d-the-engine-package-and-purity-rules)
- [E. Vocabulary: reason codes and conflict types](#e-vocabulary-reason-codes-and-conflict-types)
- [F. Input validation](#f-input-validation)
- [G. Availability computation](#g-availability-computation)
- [H. Priority scoring](#h-priority-scoring)
- [I. Scheduling engine](#i-scheduling-engine)
- [J. Conflict engine](#j-conflict-engine)
- [K. Deadline engine](#k-deadline-engine)
- [L. Dependency engine](#l-dependency-engine)
- [M. Workload engine](#m-workload-engine)
- [N. Rescheduling and carry-forward](#n-rescheduling-and-carry-forward)
- [O. Explanations](#o-explanations)
- [P. Versioning, idempotency and concurrency](#p-versioning-idempotency-and-concurrency)
- [Q. Autonomy enforcement](#q-autonomy-enforcement)
- [R. Worker queue architecture](#r-worker-queue-architecture)
- [S. Audit events](#s-audit-events)
- [T. Domain vocabulary and validation](#t-domain-vocabulary-and-validation)
- [U. Environment configuration](#u-environment-configuration)
- [V. Testing strategy](#v-testing-strategy)
- [W. Security review, performance and known limitations](#w-security-review-performance-and-known-limitations)

---

## A. Objective and scope

Stage 5 implements the **Space Engine**: the set of deterministic rules that
produce a user's day. It turns raw inputs — working hours, tasks with deadlines
and priorities, dependencies, calendar events, reminders — into a plausible,
explainable plan with no randomness, no AI, and no mutable global state.

In scope:

- A new pure package, `@space/engine`, containing the full planning pipeline:
  availability, priority scoring, scheduling, conflicts, deadlines,
  dependencies, workload, rescheduling, and explanations.
- A stable reason-code vocabulary and conflict-type vocabulary, so every
  decision and every disagreement has one machine-readable name.
- The schema and repository support for task dependencies.
- A planning worker (BullMQ) that loads a day's snapshot, runs the engine, and
  persists the plan under an optimistic-concurrency guard.
- Autonomy enforcement at the persistence boundary.

Explicitly out of scope (deferred to later stages):

- **The reminder dispatcher, notification delivery and the outbox consumer.**
  The audit trail exists; consuming it is Stage 7 work.
- **Recurrence expansion of reminders and calendar series** into concrete
  occurrences.
- **Calendar writes and Google Calendar mutation.** The engine schedules around
  real events; it never edits them.
- **A web/UI planning surface.** The engine runs in the worker; endpoint wiring
  for "plan my day" is a follow-up.

---

## B. Early decisions

| Decision                                                      | Why                                                                                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The engine is a **pure package with zero I/O imports**        | No Prisma, Google, BullMQ, Next.js or React in `@space/engine`. Purity is what makes a retried job safe and a replay bit-for-bit identical.                 |
| **Determinism by construction**, not by discipline            | Stable tie-breaks everywhere (priority level, earliest start, then `id`); no `Math.random`, no wall-clock in decisions; `plan()` accepts an injected clock. |
| Input is a **snapshot value** (`PlanningInput`), not a cursor | The whole day is materialised once and passed in; the same input always produces the same result, which unit tests can pin exactly.                         |
| Reason codes are **enum-level official vocab**                | Every reason code, conflict type and action type is a named constant in `types.ts`. Ambiguity and magic strings are impossible by construction.             |
| Backwards scheduling for deadlines                            | Deadlines are met by reserving time from the due instant backwards, not by hoping the forward pass lands before it.                                         |
| Each engine is its own module with its own tests              | 10 pipeline stages, 9 modules, ~90 unit tests — a stage is replaceable in isolation without re-proving the others.                                          |
| Version claim happens **inside the persistence transaction**  | `updateMany WHERE planVersion = loaded` is a compare-and-swap; a concurrent edit or planning pass makes the loser a no-op, never a clobber.                 |
| Autonomy is a **persistence policy**, not an engine rule      | The engine always computes the best plan; the _application_ decides whether to apply it, so `SUGGEST_ONLY` shares the same reasoning.                       |
| `@space/engine` is consumed as source, not built              | `exports: { ".": "./src/index.ts" }`; the worker compiles it with TS. It is a typecheck-only library — no tsup/jit build step to keep.                      |

---

## C. Data model and migrations

Two migrations were added.

### `20260910000000_engine_task_dependencies`

The `task_dependencies` table models "task X cannot start before task Y
finishes":

```sql
CREATE TABLE "task_dependencies" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "taskId"      TEXT NOT NULL,
    "dependsOnId" TEXT NOT NULL,
    "createdAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMPTZ(3) NOT NULL,
    PRIMARY KEY ("id"),
    CONSTRAINT "task_dependencies_no_self_dependency" CHECK ("taskId" <> "dependsOnId")
);
CREATE UNIQUE INDEX "task_dependencies_taskId_dependsOnId_key"
  ON "task_dependencies"("taskId", "dependsOnId");
CREATE INDEX "task_dependencies_dependsOnId_idx" ON "task_dependencies"("dependsOnId");
CREATE INDEX "task_dependencies_userId_taskId_idx" ON "task_dependencies"("userId", "taskId");
```

- The **composite unique key** makes inserts idempotent: a planner pass that
  runs twice cannot double an edge.
- The **CHECK constraint** forbids self-dependency at the database, and
  `createDependencySchema` forbids it earlier, in validation.
- Foreign keys cascade both ways (`taskId` and `dependsOnId` both `ON DELETE
CASCADE`), so deleting either task removes the edge.
- The engine's loading query is the `(userId, taskId)` index; `dependsOnId` is
  indexed for reverse lookups ("everything this task gates").

The Prisma model defines both relation directions on `Task` —
`dependencies` (edges this task owns) and `prerequisiteOf` (edges that gate it).

### `20260910100000_engine_planning_events`

PostgreSQL enum values for the planning lifecycle (additive only, per
Postgres' no-ADD-VALUE-in-transaction rule):

```sql
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'PLANNING_STARTED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'PLANNING_COMPLETED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'PLANNING_FAILED';
```

No change was needed to `AgentActionType`: the Stage 0 vocabulary already named
every action the engine proposes (`SPACE_PLANNED`, `TASK_SCHEDULED`,
`TASK_RESCHEDULED`, `TASK_DEFERRED`, `CONFLICT_RESOLVED`, `WORKLOAD_BALANCED`,
`DEADLINE_ENFORCED`). The enum-parity test keeps all of this identical to
`@space/types`.

---

## D. The engine package and purity rules

`@space/engine` is a new workspace package. Its `package.json` declares exactly
two dependencies — `@space/time` and `@space/types` — chosen because both are
themselves pure and dependency-light. **The package contains no database, no
I/O, no HTTP, no queue and no React import anywhere in `src/`**, and a test
asserts the whole suite stays green without any of them.

Modules and the pipeline they implement (`planner.ts` documents this order,
which is itself a test-pinned contract):

| #   | Module            | Exports                     | Responsibility                                    |
| --- | ----------------- | --------------------------- | ------------------------------------------------- |
| 1   | `validator.ts`    | `validatePlanningInput`     | Structural and rule validation, duration defaults |
| 2   | `availability.ts` | `computeAvailability`       | Working hours minus calendar and existing items   |
| 3   | `priority.ts`     | `scoreAndSortTasks`         | Deadline proximity × priority × strategy ordering |
| 4   | `scheduling.ts`   | `scheduleTasks`             | Earliest-fit placement with strategy slot choice  |
| 5   | `conflicts.ts`    | `detectAndResolveConflicts` | Overlap detection and deterministic resolution    |
| 6   | `deadlines.ts`    | `enforceDeadlines`          | Backwards placement from due instants             |
| 7   | `dependencies.ts` | `resolveDependencies`       | Topological ordering, cycle detection             |
| 8   | `workload.ts`     | `enforceWorkload`           | Max focus, breaks, weekend rules                  |
| 9   | `rescheduling.ts` | `reschedule`                | Minimal-edit comparison with the existing day     |
| 10  | `explanation.ts`  | `generateExplanations`      | One human-readable explanation per decision       |

The exported entry point is a single call:

```ts
plan(input: PlanningInput, clock: Clock = new FixedClock('2026-01-01T00:00:00.000Z')): PlanningResult
```

Every decision in the output carries a `reasonCode`; the same input yields the
same `PlanningResult` (the injected clock is used only to report `durationMs`).

---

## E. Vocabulary: reason codes and conflict types

`types.ts` defines the official vocabularies.

**`REASON_CODES`** — 39 constants in five families:

- `HARD_*` (the task could not be placed and why): `HARD_WORKING_HOURS`,
  `HARD_CALENDAR_BLOCK`, `HARD_DEPENDENCY_BLOCKED`, `HARD_DEADLINE_CONFLICT`,
  `HARD_NO_SLOTS`, `HARD_MAX_FOCUS_EXCEEDED`, `HARD_WEEKEND_BLOCKED`,
  `HARD_AUTONOMY_SUGGEST_ONLY`, `HARD_AUTONOMY_ASK_REQUIRED`.
- `SOFT_*` (placement/ordering heuristics): `SOFT_PRIORITY_ORDER`,
  `SOFT_DEADLINE_PROXIMITY`, `SOFT_EARLIEST_START`,
  `SOFT_STRATEGY_BALANCED`, `SOFT_STRATEGY_EARLIEST_FIT`,
  `SOFT_STRATEGY_DEADLINE_FIRST`, `SOFT_BUFFER_INSERTED`,
  `SOFT_BREAK_REQUIRED`, `SOFT_PREFERRED_PLANNING_TIME`.
- `CONFLICT_*`: `CONFLICT_OVERLAP`, `CONFLICT_RESOLVED_BY_PRIORITY`,
  `CONFLICT_RESOLVED_BY_DELEGATION`, `CONFLICT_RESCHEDULED`.
- `SCHEDULED_*` / `UNSCHEDULED_*`: `SCHEDULED_PLACED`,
  `SCHEDULED_CALENDAR_ANCHORED`, `SCHEDULED_REMAINDER`, `UNSCHEDULED_NO_SLOTS`,
  `UNSCHEDULED_DEPENDENCY_CHAIN`, `UNSCHEDULED_DEADLINE_UNREACHABLE`,
  `UNSCHEDULED_WORKLOAD_EXCEEDED`, `UNSCHEDULED_AUTONOMY_RESTRICTED`.
- `RESCHEDULED_*` / `EXPLANATION_*`: carry-forward, conflict-repair and
  minimal-edit variants; seven explanation strategems.

**`CONFLICT_TYPES`** — 6: `TASK_CALENDAR_OVERLAP`, `TASK_TASK_OVERLAP`,
`TASK_OUTSIDE_WORKING_HOURS`, `DEADLINE_UNREACHABLE`, `DEPENDENCY_CYCLE`,
`DEPENDENCY_MISSING_PREREQUISITE`.

**`EngineActionType`** is the 7-element subset of `AgentActionType` the engine
proposes. `ProposedAction` is the database-ready shape (`actionType`,
`entityType`, `entityId`, `reason`, `factors`, and optional `previousState` /
`resultingState`); `EngineAction` is the looser shape the sub-modules emit
before the planner annotates them, keeping each module decoupled.

**Determinism rule that pins the vocabulary:** reason codes are compared by
identity, never generated by concatenation, so a code is a single atom a test
can assert against.

---

## F. Input validation

`validatePlanningInput(input)` returns `{ valid, violations }` and never
throws. It enforces:

- Required snapshot fields (`userId`, `date`, `timeZone`, `space.id`,
  non-negative `planVersion`).
- Positive durations (`defaultTaskDurationMinutes`, `maxDailyFocusMinutes`),
  non-negative breaks and buffer.
- Per-task: non-empty `id`, positive `estimatedMinutes` when set, and a warning
  when a task's deadline precedes its scheduled end.
- Structural rules: no self-dependency, valid working-hour ranges
  (`startMinute < endMinute`).

`normalizeTaskDurations(tasks, default)` fills null `estimatedMinutes` with the
user's default before anything else runs, so downstream modules never divide by
a missing duration.

In the worker, an invalid input is treated as a **permanent failure**: the job
raises (recorded as `PLANNING_FAILED`) instead of entering a retry loop with
BullMQ, because re-validating the same data cannot change the verdict.

---

## G. Availability computation

`computeAvailability` builds the day's free time in the user's zone:

1. Start from the day range `[startOfDay, startOfNextDay)` (DST-safe via
   `calendarDateRange`).
2. Subtract the user's working-hour blocks for that weekday (missing blocks mean
   no free time that weekday).
3. Subtract hard calendar events (`TASK_CALENDAR_OVERLAP`-producers) — CONFIRMED
   and TENTATIVE, excluding CANCELLED and deleted.
4. Subtract existing space items, treating them as immutable anchors the engine
   plans around unless rescheduling later negotiates them.

`findSlotsForTask(slots, duration, buffer)` then returns the candidate windows
for one task, applying the configured `bufferMinutes` of padding around
occupied time. Both are pure and fully unit-tested (slot splitting, overlaps,
buffer overlap).

---

## H. Priority scoring

`scoreAndSortTasks` produces the deterministic order scheduling consumes. The
composite key is deliberately transparent:

1. **Deadline proximity** — tasks closer to their due instant sort first
   (measured against the target day; no deadline = lowest urgency).
2. **Task priority level** — `CRITICAL > HIGH > NORMAL > LOW` (the enum order
   the database already uses for sorting).
3. **Stable id** — a total, repeatable tie-break so two runs against unchanged
   data are identical.

The strategy is also consulted: `DEADLINE_FIRST` amplifies deadline weight,
`EARLIEST_FIT` accepts the first fitting slot and prefers short work, and
`BALANCED` is the default middle path. `ScoredTask` carries the decomposed keys
so a test can assert _why_ A precedes B, not just that it does.

---

## I. Scheduling engine

`scheduleTasks` walks the scored list and greedily places each task into the
earliest slot that fits, choosing among candidate slots by the active strategy:

- `EARLIEST_FIT` — earliest start, then shortest task.
- `BALANCED` — earliest start with a spread preference (avoids cramming).
- `DEADLINE_FIRST` — prefers placement that keeps the deadline satisfiable.

Buffer minutes are carved around placed blocks (`SOFT_BUFFER_INSERTED`).
Scheduled blocks are pure values: `{ kind, itemId, start, end, position,
reasonCode }`. A task with no fitting slot is returned as `UnscheduledTask`
with `HARD_NO_SLOTS`. Placement is deterministic: candidates are ordered by the
same stable keys as scoring.

---

## J. Conflict engine

`detectAndResolveConflicts` runs after the initial placement and reports every
disagreement between planned work and reality:

- `TASK_TASK_OVERLAP` — two scheduled tasks collide; resolution keeps the
  higher-priority one in place and defers the other (`CONFLICT_RESOLVED_BY_PRIORITY`),
  never random.
- `TASK_CALENDAR_OVERLAP` — a task landed on a hard event; the task yields
  (`CONFLICT_RESCHEDULED`) and re-enters the placement pool.
- `TASK_OUTSIDE_WORKING_HOURS` — placed outside the user's availability window.
- `DEADLINE_UNREACHABLE` — no placement can satisfy the deadline this day.
- `DEPENDENCY_CYCLE` / `DEPENDENCY_MISSING_PREREQUISITE` — the dependency
  validations (section L) surface here as conflicts.

Every conflict carries a human-readable `description` and `resolution`, so a
user can be told exactly what was traded and why. The resolution is a _rule_, not
a preference: which task won is recoverable from the reason codes alone.

---

## K. Deadline engine

Deadlines are enforced **backwards**: `enforceDeadlines` reserves time from
`dueAt − estimatedMinutes` and checks whether that window is free, rather than
hoping the forward pass landed early enough.

- A task already scheduled **inside** its deadline is left alone.
- A task scheduled **after** its deadline is flagged with `HARD_DEADLINE_CONFLICT`
  and re-placed before the instant if a free window exists.
- An **unscheduled** task whose deadline is reachable (its duration fits before
  it) is pulled back onto the day (`DEADLINE_ENFORCED`);
  `UNSCHEDULED_DEADLINE_UNREACHABLE` is emitted when even a midnight-to-deadline
  window cannot hold it.

The reachability check compares `dueAt − duration` against the day's start
(midnight), a decision pinned by test. It is the single most consequential
heuristic in the stage — a task a user wanted done today is either guaranteed
time or told, with a specific code, that the day cannot hold it.

---

## L. Dependency engine

`resolveDependencies` (with `hasCycle`) enforces prerequisite ordering:

1. Builds the dependency graph from `PlanningDependency[]`.
2. Runs a **topological sort** producing a deterministic work order: a task that
   depends on others is never scheduled to start before its prerequisites
   complete.
3. **Cycle detection** (Kahn's algorithm + DFS) reports every loop as a
   `DEPENDENCY_CYCLE` conflict; the involved tasks are surfaced as unscheduled
   with the cycle named.
4. A task whose prerequisite is not part of the day's pool is reported as
   `DEPENDENCY_MISSING_PREREQUISITE` — the engine refuses to fabricate a
   prerequisite's schedule.

The scheduler is dependency-aware during placement: a dependent task only
accepts slots _after_ the prerequisite's end (`HARD_DEPENDENCY_BLOCKED` when no
such slot exists). Persistence of edges lives in `@space/database`:
`createDependency` (idempotent upsert by unique key), `deleteDependency`,
`listDependenciesForTask`, `listDependenciesForTasks` (the loader's query) and
`listAllDependencies` (bounded, export-oriented).

---

## M. Workload engine

`enforceWorkload` enforces the user's capacity rules on the final schedule:

- **Max daily focus** (`maxDailyFocusMinutes`): once accumulated scheduled focus
  reaches the cap, later work is deferred (`HARD_MAX_FOCUS_EXCEEDED`,
  `UNSCHEDULED_WORKLOAD_EXCEEDED`). The comparison is strict `>` — an exact
  capacity fit is legal (4×60 min in a 240-min budget), pinned by test.
- **Breaks** (`minBreakMinutes`): consecutive focus blocks are separated by at
  least the minimum break (`SOFT_BREAK_REQUIRED`); the break is carved out of
  the schedule up front.
- **Weekends** (`allowWeekendScheduling`): by default no task is placed on a
  Saturday or Sunday (`HARD_WEEKEND_BLOCKED`).

The workload pass runs _after_ deadlines and dependencies, so capacity is the
final arbiter: a deadline may force a task in, but the workload engine decides
what still fits under it.

---

## N. Rescheduling and carry-forward

`reschedule` is the minimal-edit layer that compares the fresh plan against the
day as it currently exists (`ExistingSpaceItem[]`):

- **Carry-forward** (`RESCHEDULED_CARRY_FORWARD`): work from an _earlier_ day
  that is still in `INBOX`/`PLANNED` state and was already placed on the target
  timeline is kept — the plan inherits previously scheduled items rather than
  reinventing them.
- **Conflict repair** (`RESCHEDULED_CONFLICT_REPAIR`): items displaced by new
  conflicts are re-placed deterministically by the same scoring.
- **Minimal edit** (`RESCHEDULED_MINIMAL_EDIT`): an item whose existing
  placement is already consistent is left untouched; the plan only writes rows
  that changed.
- `RESCHEDULED_UNCHANGED` is emitted when a block did not move. It is
  unreachable through the full `plan()` pipeline (an existing item occupies its
  own slot in availability), so tests exercise `reschedule` directly — a
  documented, deliberate seam.

The plan is therefore _fair_ to prior human decisions: it changes as little as
it can while honouring deadlines, dependencies and capacity.

---

## O. Explanations

`generateExplanations` produces one `Explanation` per scheduled/unscheduled
decision and `generatePlanSummary` a one-paragraph plain-language summary of the
day. Each explanation pairs a human `message` with the machine `reasonCode` and
the `factors` the rule read, e.g.:

- priority order (`EXPLANATION_PRIORITY`),
- deadline proximity (`EXPLANATION_DEADLINE`),
- dependency block (`EXPLANATION_DEPENDENCY`),
- calendar hard block (`EXPLANATION_CALENDAR`),
- capacity (`EXPLANATION_WORKLOAD`),
- autonomy restrictions (`EXPLANATION_AUTONOMY`),
- strategy choice (`EXPLANATION_STRATEGY`).

This is the product-facing surface: the dashboard can render "why did my day
change" purely from `PlanningResult.explanations` and the audit row's
`reason`/`factors`, with no engine knowledge in the UI.

---

## P. Versioning, idempotency and concurrency

`Space.planVersion` is the optimistic-concurrency currency of this stage.

- The web/API (future wiring) reads the space, then enqueues a planning job
  carrying `{ userId, date, spaceId, planVersion }`.
- The worker **re-checks** the version on load (`planVersion` equal or the job
  is stale → `{ skipped: 'stale-version' }`).
- Persistence runs in one `$transaction`. The **first write is the claim**:
  `UPDATE space SET planVersion = planVersion + 1 WHERE id = :spaceId AND
userId = :userId AND planVersion = :loaded`. `updateMany` returns 0 when a
  foreground edit or another pass moved the version first, and the whole
  transaction rolls back — the loser changed nothing.
- Everything else (space items, task `scheduledStart`/`scheduledEnd`,
  `agent_actions`, `event_logs`) commits atomically with the claim.

Because the engine is pure, a retried job computes the **same** plan; the
version guard makes re-application a no-op. Idempotency is therefore structural
rather than checked-by-handling.

---

## Q. Autonomy enforcement

The engine always computes the best plan; **autonomy decides what gets written**,
in `persistPlanningResult`:

| `autonomyLevel`        | Persistence behaviour                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SUGGEST_ONLY`         | Nothing touches tasks or space items. The full result is recorded as `AgentAction` rows with outcome `SKIPPED`.                                                    |
| `ASK_BEFORE_CHANGING`  | New placements are applied; an item **already on the day is never moved** (matches `RESCHEDULED_MINIMAL_EDIT`'s promise). Proposed moves are audited as `SKIPPED`. |
| `AUTOMATICALLY_MANAGE` | The full plan is applied; the space is marked `ACTIVE` / `plannedAt` and every action audited `SUCCEEDED`.                                                         |

`HARD_AUTONOMY_SUGGEST_ONLY` / `HARD_AUTONOMY_ASK_REQUIRED` reason codes also
exist for tasks _the engine_ decides it may not place, so the engine and the
application cannot disagree about what "suggest only" means.

---

## R. Worker queue architecture

`@space/worker` gains a fourth queue:

| Queue      | Name             | Attempts | Backoff         | Consumed by     |
| ---------- | ---------------- | -------- | --------------- | --------------- |
| `planning` | `space:planning` | 2        | exponential 10s | planning-worker |

`apps/worker/src/queues/planning-worker.ts` owns the full lifecycle of one
pass:

1. **Start audit** — `PLANNING_STARTED` appended (correlation id per pass).
2. **Load snapshot** — space (with `planVersion`), `planningPreferences`,
   `userPreferences` (time zone), working hours, existing space items, the task
   pool (space tasks ∪ tasks scheduled that day ∪ tasks due that day, de-duped
   and capped at `PLANNING_MAX_TASKS_PER_PLAN`), calendar events overlapping the
   day, pending reminders, dependencies. Loaded with `Promise.all`.
3. **Validate + plan** — `validatePlanningInput`, then `plan(input, clock)`.
4. **Persist** — version claim + autonomy policy (section Q), in one
   transaction.
5. **ATL audit** — `PLANNING_COMPLETED` (with counts, mode, `durationMs`) or
   `PLANNING_FAILED` (with truncated message). The failure path's audit write
   swallows its own errors so it can never mask the original.

The worker only starts when a database is present; it has no OAuth dependency,
so it activates in every deployment that already runs the calendar worker.

---

## S. Audit events

Each planning pass emits exactly one lifecycle event (all under
`aggregateType: SPACE`, `aggregateId: spaceId`, tied together by
`correlationId`):

| Event                | Emitted when                                  | Payload highlights                                                       |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| `PLANNING_STARTED`   | job begins                                    | —                                                                        |
| `PLANNING_COMPLETED` | persistence succeeded or legitimately skipped | mode, scheduled/unscheduled/conflict counts, `planVersion`, `durationMs` |
| `PLANNING_FAILED`    | any failure                                   | truncated message                                                        |

Every engine decision additionally lands as one `AgentAction` row per proposed
action (`SPACE_PLANNED`, `TASK_SCHEDULED`, `TASK_RESCHEDULED`,
`TASK_DEFERRED`, `CONFLICT_RESOLVED`, `WORKLOAD_BALANCED`,
`DEADLINE_ENFORCED`), with `reason` (the rule), `factors` (the inputs read),
`outcome` (`SUCCEEDED` or `SKIPPED` by autonomy), `correlationId` and
`durationMs`. This is a true audit trail of rule execution: `listAgentActionsForSpace`
(Stage 0) can reconstruct _why any day looks the way it does_.

---

## T. Domain vocabulary and validation

- `EVENT_TYPES` gained `PLANNING_STARTED`, `PLANNING_COMPLETED`,
  `PLANNING_FAILED` (dual-sided with the Prisma enum; parity test enforced).
- `AGENT_ACTION_TYPES` needed no change — it already named all seven engine
  actions.
- `AGGREGATE_TYPES` unaffected (engine actions reuse existing aggregates:
  `TASK`, `SPACE`, etc.).
- `createDependencySchema` in `@space/validation` validates the edge
  (`taskId`, `dependsOnId`, `taskId !== dependsOnId`), used by the dependency
  repository before any write.
- The engine's own `PlanningInput`/`PlanningResult` shapes live in
  `@space/engine` (they are engine-owned contracts), built on `@space/types`
  vocabulary (`CalendarDate`, `TimeZone`, `DurationMinutes`, `Weekday`,
  enums) with the branded `DurationMinutes`/`TimeZone` values produced by the
  `@space/validation` temporal schemas.

---

## U. Environment configuration

| Variable                      | Reader | Notes                                           |
| ----------------------------- | ------ | ----------------------------------------------- |
| `PLANNING_MAX_TASKS_PER_PLAN` | worker | 1–2000, default 100; hard cap per planning pass |

The guardrail makes a pathological day fail loudly (`planning input invalid`)
instead of silently scheduling hours of work. No new secrets; the queue reuses
`REDIS_URL`/`DATABASE_URL` and the database pool already shared with the
calendar worker.

---

## V. Testing strategy

Unit tests (no network, no database — the engine's purity makes them instant):

- `@space/engine` — **90 tests across 10 files**, one file per module plus a
  `planner.test.ts` integration of the full pipeline:
  - validator: structural violations, duration normalisation defaults.
  - availability: DST range, block carving, buffer overlap, immutable anchors.
  - priority: deadline-first, priority-level, id tie-break, strategy weights.
  - scheduling: strategy-specific slot choice, buffer insertion, no-slot deferral.
  - conflicts: task/calendar and task/task overlaps, priority resolution.
  - deadlines: reachable vs unreachable, backward placement, already-in-deadline.
  - dependencies: topological order, cycle detection, missing prerequisite.
  - workload: max-focus strict `>`, break carving, weekend block.
  - rescheduling: carry-forward, minimal-edit, unchanged (direct call).
  - planner: version increment, summary, action collection, idempotency of
    repeated `plan()` calls.
- Repo-wide: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and
  `pnpm format:check` are all green. The engine's default-dependency test suite
  (validator/availability/etc.) covers input shapes, and the enum-parity suite
  in `@space/database` cross-pins `EVENT_TYPES` with the Prisma schema.

Not unit-tested (must run in CI with infrastructure):

- The worker's database-backed loader/persister and the migration files are
  validated by typecheck + lint here; the migration SQL is applied by
  `prisma migrate deploy` in CI.

---

## W. Security review, performance and known limitations

### Security review

- **No engine I/O.** `@space/engine` cannot read the network, the database, or
  the filesystem, so no engine code path can exfiltrate or be used as a fishing
  probe. Ownership lives entirely in the worker's `where` clauses.
- **Ownership on every write.** The version claim and every item write are
  scoped `(id, userId)`; a job payload carries no authority beyond the pair.
- **Correlation ids, not user input.** Per-pass `correlationId` is generated
  server-side; no untrusted string reaches `reason`/`payload` un-bounded (both
  are truncated at 500 chars, and payloads never contain credentials).
- **Autonomy as a boundary, not a convenience flag.** `SUGGEST_ONLY` cannot
  write task or space-item rows by construction (it returns before the
  transaction), so a misconfigured deployment at worst over-recommends, never
  overwrites.
- **Audit even on failure.** The `PLANNING_FAILED` event is attempted before
  rethrowing, so an operator can always see the last thing a pass tried to do.

No High-severity findings.

### Performance considerations

- Snapshot loading is one `Promise.all` of indexed, per-user queries; the task
  pull is bounded by `CAP` and by the day's range.
- The engine is O(tasks × slots × edges) worst-case and effectively linear in a
  normal day (< 100 tasks); no recursion other than dependency DFS, no
  unbounded in-memory growth.
- The `(userId, taskId)` dependency index and `(userId, scheduleStart)`-shaped
  indexes make the loader queries index-only.
- `plan()` is pure and cacheable: identical snapshots can be memoised later if
  profiling ever warrants it.

### Known limitations and deferred work

1. **Database-backed paths unverified locally.** No local Postgres/Redis, so the
   task-dependency migration, the planning worker's loader/persister, and the
   BullMQ queue were validated by typecheck, lint and the offline suites. The
   migrations are applied and integration-tested in CI.
2. **No web/API planning surface yet.** The queue and engine exist; the "plan my
   day" endpoint and calendar UI wiring are follow-up work, as is the
   `ask-before-changing` interactive confirm flow (the engine already writes
   only new placements; prompting the user to approve _moves_ is UI work).
3. **`docs/plans/` does not exist in this repository;** the only planning
   artifact is this document, alongside the Stage 4 report and README (which is
   stale at "Stage 03 — Identity" and out of scope here).
4. **Recurrence expansion** and the **reminder dispatcher / outbox consumer**
   remain deferred (Stage 7); the audit trail this stage writes is exactly what
   that consumer is designed to read.
5. **Delegation resolution** (`CONFLICT_RESOLVED_BY_DELEGATION`) is a reserved
   reason code; the delegation engine itself is a later stage.
