# Stage 8 — Autonomous Space Loop

This document records what Stage 8 built: a deterministic, event-driven loop
that observes real-world signals, detects changes, classifies them, and
delegates replans — all without AI/LLM, all on the existing BullMQ worker
infrastructure.

- [A. Objective and scope](#a-objective-and-scope)
- [B. Design principles](#b-design-principles)
- [C. Change classification](#c-change-classification)
- [D. Plan diff: what changed](#d-plan-diff-what-changed)
- [E. Review phases](#e-review-phases)
- [F. Coalescing and idempotency](#f-coalescing-and-idempotency)
- [G. Worker wiring](#g-worker-wiring)
- [H. Database: transitionTaskStatus](#h-database-transitiontaskstatus)
- [I. Calendar sync: CALENDAR_CHANGED](#i-calendar-sync-calendar_changed)
- [J. Planning worker: SPACE_OPTIMIZED](#j-planning-worker-space_optimized)
- [K. Notification integration](#k-notification-integration)
- [L. Configuration](#l-configuration)
- [M. Testing](#m-testing)
- [N. Verification](#n-verification)
- [O. Known limitations and future work](#o-known-limitations-and-future-work)

---

## A. Objective and scope

Stage 8 delivers the **autonomous space loop**: a background process that
periodically observes the state of every user's schedule, detects changes that
warrant a replan, and delegates that replan to the existing planning worker.

In scope:

- **`@space/autonomy` package**: pure classification, plan diff, and review
  service modules.
- **Autonomy review worker**: a BullMQ repeatable job (`space:autonomy-review`)
  that runs the OBSERVE → DETECT → CLASSIFY → DELEGATE pipeline.
- **Plan diff**: deterministic comparison between a day's items before and
  after a planning pass, with stable reason codes for audit and UI.
- **Review phases**: missed blocks, deadline risk, calendar drift, tomorrow
  planning — all with bounded queries and idempotent writes.
- **Task transitions**: `transitionTaskStatus` helper in the database layer,
  with audit event emission and agent action recording.
- **Calendar sync integration**: `CALENDAR_CHANGED` events emitted after
  successful sync, feeding the calendar drift phase.
- **Notification integration**: `evaluateTaskMissed` and
  `evaluateDeadlineWarning` wired into the review phases, producing idempotent
  notification drafts.
- **This document.**

Explicitly out of scope:

- **AI/LLM-generated decisions.** Every rule is a pure function of stored
  facts; no model is called.
- **Task mutation UI.** No new API endpoints or UI surfaces for creating or
  editing tasks are added in this stage.
- **New Prisma tables.** The loop operates entirely over existing schema.

---

## B. Design principles

1. **Determinism.** The same input state produces the same classification,
   the same diff, and the same replan decision — every time, on every retry.

2. **One loop, many signals.** A single repeatable job observes multiple
   signal types (missed blocks, deadlines, calendar changes, unplanned
   tomorrows) rather than one job per signal per user.

3. **Coalescing over storm.** A space is replanned at most once per
   coalescing window (5 minutes, configurable) unless the change is URGENT.
   The BullMQ `jobId` replacement ensures at most one pending job per space.

4. **Replans via existing path.** The loop never plans directly — it enqueues
   a job on the `space:planning` queue with `trigger: 'autonomous'`, so the
   same engine, the same persistence path, and the same optimistic concurrency
   guard serve both user clicks and autonomous passes.

5. **Notifications are side-effects, not signals.** The loop produces
   notification drafts (missed-task, deadline-warning) idempotently via
   `deliveryKey` — same as Stage 7's sweep.

---

## C. Change classification

Every domain event the loop might observe maps to exactly one **classification**
and one stable **reason code**:

| Classification    | Meaning                                                      |
| ----------------- | ------------------------------------------------------------ |
| `NO_REPLAN`       | The event does not affect any day the loop manages.          |
| `REVIEW_ONLY`     | The event is worth auditing but does not invalidate a plan.  |
| `REPLAN_REQUIRED` | A plan may be stale; re-run the engine for the affected day. |
| `URGENT_REPLAN`   | The plan is definitely stale or a deadline is unmeetable.    |

The mapping is total: an event type this module has never seen classifies as
`NO_REPLAN` rather than throwing, so a newer producer can never break an older
loop.

Classification is implemented in `packages/autonomy/src/change.ts` — a pure
function with no database or clock dependency.

---

## D. Plan diff: what changed

After a planning pass, `computePlanDiff` compares the day's items before
(the persisted `SpaceItem` rows the snapshot loaded) with the blocks the
engine produced. Six change types:

| Type          | Meaning                                                  |
| ------------- | -------------------------------------------------------- |
| `UNCHANGED`   | Work that stayed in the same position.                   |
| `ADDED`       | Work the new plan placed that was not on the day before. |
| `MOVED`       | Work that stayed but shifted within the day.             |
| `REMOVED`     | Work that left the day for any reason.                   |
| `UNSCHEDULED` | Work that fell off the day while still open.             |
| `COMPLETED`   | Work that left because the user finished it.             |

Each entry carries a `reasonCode` (`PLAN_DIFF_ADDED`, etc.) and an optional
`engineReasonCode` from the engine's own placement logic. Calendar events are
never diffed — they are anchors.

The diff is computed pre-persist in the planning worker from
`input.existingItems` + `input.tasks` vs `result`, then appended as a
`SPACE_OPTIMIZED` event when `trigger === 'autonomous'`.

Implemented in `packages/autonomy/src/diff.ts`.

---

## E. Review phases

The review service (`packages/autonomy/src/service.ts`) runs four bounded
phases in sequence:

### E.1 Missed blocks

Queries tasks with `status: PLANNED` and `scheduledEnd < now`. For each:

- Under `AUTOMATICALLY_MANAGE`, transitions to `MISSED` via
  `transitionTaskStatus` (emitting `TASK_MISSED` event).
- Creates a `task-missed` notification draft via `evaluateTaskMissed`.

### E.2 Deadline risk

Queries open tasks with `dueAt` within the replan horizon (72h). For each:

- If the deadline is already met (scheduled end ≤ due), skip.
- If due today and not met → `URGENT_REPLAN` + `DEADLINE_IMPOSSIBLE` signal.
  Enqueue a replan.
- If due within horizon and not met → `REPLAN_REQUIRED` + `DEADLINE_IMPENDING`.
  Enqueue a replan.
- Append `DEADLINE_APPROACHING` audit event (deduplicated by task + dueAt).
- If due today: create `deadline-warning` notification draft via
  `evaluateDeadlineWarning`.

### E.3 Calendar drift

Reads recent `CALENDAR_CHANGED` events (last 2× coalesce window). For each:

- Loads the calendar's events in the replan horizon.
- Computes which calendar dates are affected (user's timezone).
- Finds planned spaces on those dates.
- Enqueues a `REPLAN_REQUIRED` replan for each.

### E.4 Tomorrow planning

For users with `AUTOMATICALLY_MANAGE` and `preferredPlanningMinute` set:

- Computes tomorrow in the user's timezone.
- If `now < cutoff` (preferred minute on tomorrow), skip.
- If tomorrow's space exists but is unplanned and has open work → enqueue.

---

## F. Coalescing and idempotency

**Per-pass dedup.** A `Set<spaceId>` inside the review prevents the same
space from being enqueued twice in one pass.

**Coalescing window.** A non-urgent change is dropped if the space was
optimized within the last `coalesceWindowMs` (default 5 minutes).

**BullMQ jobId.** Replan jobs use `jobId: 'space:replan:{spaceId}'`. BullMQ
replaces a pending job with the same ID, so at most one replan per space is
in the queue at any time.

**Version guard.** The planning worker only applies a pass whose
`planVersion` still matches the database. A racing edit or a replayed job is
a no-op.

**Notification idempotency.** Drafts use `deliveryKey` (physical unique
index) — same mechanism as Stage 7.

---

## G. Worker wiring

### G.1 New queue: `space:autonomy-review`

Defined in `apps/worker/src/queues/index.ts` alongside the existing queues.
One repeatable job (`jobId: space:autonomy-review`) runs the review on a
fixed interval (default 5 minutes).

### G.2 Autonomy review worker

`apps/worker/src/queues/autonomy-review-worker.ts` — a BullMQ worker with
`concurrency: 1` and a rate limiter (2 per 120s). It injects an
`enqueueReplan` function that adds jobs to the `space:planning` queue.

### G.3 Planning worker extension

`apps/worker/src/queues/planning-worker.ts` — after the engine computes a
result, the worker computes the plan diff. When `trigger === 'autonomous'`,
it appends a `SPACE_OPTIMIZED` event with the diff payload (counts, entries,
`hasMeaningfulChange`).

### G.4 Scheduler

`apps/worker/src/scheduler.ts` — `scheduleAutonomyReview` registers the
repeatable job, same pattern as `scheduleNotificationSweep`.

### G.5 Bootstrap

`apps/worker/src/index.ts` — the autonomy review worker starts when the
database and Redis are present. Same lifecycle as the notification worker.

---

## H. Database: transitionTaskStatus

`packages/database/src/repositories/work.ts` exports `transitionTaskStatus`,
a transactional helper that:

1. Reads the task (ownership-scoped by `userId`).
2. Enforces the transition table via `canTransitionTask`.
3. Updates `status` (and `completedAt` for COMPLETED).
4. Appends a `TASK_*` audit event (`TASK_COMPLETED`, `TASK_MISSED`, or
   `TASK_RESCHEDULED`).
5. Records a `TASK_DEFERRED` agent action with trigger and reason.

Returns `{ changed: boolean }` — `false` when the task was already in the
target status (a concurrent edit moved it first).

---

## I. Calendar sync: CALENDAR_CHANGED

`packages/calendar/src/sync.ts` emits `CALENDAR_CHANGED` after a successful
sync when events were upserted or deleted. The payload includes `calendarId`,
`upserted`, `deleted`, and `changedCount`. The event feeds the calendar drift
review phase.

---

## J. Planning worker: SPACE_OPTIMIZED

When the planning worker runs with `trigger === 'autonomous'`, it appends a
`SPACE_OPTIMIZED` event after the `PLANNING_COMPLETED` event. The payload
includes:

```json
{
  "planVersion": 3,
  "trigger": "autonomous",
  "counts": { "UNCHANGED": 5, "ADDED": 1, "MOVED": 0, ... },
  "hasMeaningfulChange": true,
  "entries": [...]
}
```

This event is the audit trail for autonomous replans — what changed, why, and
what the engine decided.

---

## K. Notification integration

The review service wires two existing notification policies:

- **`evaluateTaskMissed`** — called in the missed-blocks phase. Produces a
  `DEADLINE_WARNING` notification draft with `TASK_MISSED_KEY` delivery key.
- **`evaluateDeadlineWarning`** — called in the deadline phase for tasks due
  today. Produces a `DEADLINE_WARNING` draft with `DEADLINE_WARNING_KEY`.

Both are deduplicated by `deliveryKey` (physical unique index) and gated by
`notificationsEnabled`. Email is attached only when
`emailNotificationsEnabled` is true.

---

## L. Configuration

One new env var in `packages/config/src/worker.ts`:

```
AUTONOMY_REVIEW_INTERVAL_MINUTES=5  (default, min 1, max 60)
```

Documented in `apps/worker/.env.example`.

---

## M. Testing

The `@space/autonomy` package has 28 tests across three files:

- **`change.test.ts`** — 12 tests: classification of known event types,
  monotonic ranking, `atLeast` ordering.
- **`diff.test.ts`** — 7 tests: UNCHANGED, MOVED, COMPLETED, REMOVED,
  UNSCHEDULED, ADDED, mixed diff, CALENDAR_EVENT exclusion.
- **`service.test.ts`** — 5 tests: service creation, empty review,
  missed-task detection + notification, replan coalescing within a pass,
  coalescing-window skip for recently optimized spaces.

All tests use pure mocks (no database, no Redis). The service tests mock the
database layer with `vi.fn()` stubs that match the shape the service reads.

---

## N. Verification

All workspace checks pass:

- `pnpm lint` — 16/16 tasks
- `pnpm typecheck` — 16/16 tasks
- `pnpm test` — 15/15 tasks (28 new autonomy tests + 66 notification tests +
  existing tests)
- `pnpm build` — 3/3 tasks (web, worker, notifications)
- `pnpm format:check` — clean

---

## O. Known limitations and future work

1. **No task mutation UI.** The autonomous loop can mark tasks MISSED, but
   there is no API endpoint or UI for users to create, edit, or complete
   tasks. That is a future stage.

2. **No new Prisma tables.** The loop operates over existing `Task`, `Space`,
   `PlanningPreferences`, `UserPreferences`, and `EventLog` models. Dedup for
   missed-task notifications relies on the physical `deliveryKey` unique
   index, not a dedicated dedup table.

3. **Tomorrow planning is single-pass.** The tomorrow phase enqueues one
   replan per user per review cycle. If the replan fails, the next cycle
   retries.

4. **Calendar drift horizon.** The drift phase looks back 2× the coalesce
   window and forward 72 hours. Events outside this window are not acted on.

5. **No weekend awareness.** The tomorrow phase does not check
   `allowWeekendScheduling` before enqueuing a replan. The engine's own
   `enforceWorkload` module handles weekend constraints during the pass.
