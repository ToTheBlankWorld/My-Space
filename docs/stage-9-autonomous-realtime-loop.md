# Stage 9 — Real-Time Autonomous Space Loop

This document records what Stage 9 built: a production-grade autonomous loop
that continuously reacts to meaningful changes in the user's world and keeps
their Space plan coherent — all without AI/LLM, all deterministic, all
explainable, all auditable.

- [A. Objective and scope](#a-objective-and-scope)
- [B. Design principles](#b-design-principles)
- [C. Architecture: the enhanced review pipeline](#c-architecture-the-enhanced-review-pipeline)
- [D. Trigger graph](#d-trigger-graph)
- [E. Affected-space detection](#e-affected-space-detection)
- [F. Impact analysis](#f-impact-analysis)
- [G. Plan staleness model](#g-plan-staleness-model)
- [H. Autonomy policy enforcement](#h-autonomy-policy-enforcement)
- [I. Feedback-loop prevention](#i-feedback-loop-prevention)
- [J. Notification batching](#j-notification-batching)
- [K. Integration with existing infrastructure](#k-integration-with-existing-infrastructure)
- [L. Concurrency and idempotency](#l-concurrency-and-idempotency)
- [M. Observability](#m-observability)
- [N. Security](#n-security)
- [O. Testing](#o-testing)
- [P. Verification](#p-verification)
- [Q. Known limitations and future work](#q-known-limitations-and-future-work)

---

## A. Objective and scope

Stage 9 delivers the **real-time autonomous space loop**: a background process
that continuously evaluates events from the event log, determines their impact
on the user's plans, enforces autonomy policy, prevents feedback loops, batches
notifications, and delegates replans — all through the existing planning worker.

In scope:

- **`@space/autonomy` package additions**: trigger graph, affected-space
  detection, impact analysis, plan staleness, autonomy policy, feedback-loop
  prevention, notification batching.
- **Enhanced review pipeline**: Phase 0 (trigger-graph event scan) integrated
  into the existing `createAutonomyService`.
- **6 new modules** with 77 new tests (105 total, up from 28).
- **This document.**

Explicitly out of scope:

- **AI/LLM-generated decisions.** Every rule is a pure function of stored
  facts; no model is called.
- **Task mutation UI.** No new API endpoints or UI surfaces.
- **New Prisma tables.** The loop operates entirely over existing schema.
- **Worker topology changes.** The existing BullMQ worker architecture is
  preserved; no new workers or queues were added.

---

## B. Design principles

1. **Determinism.** The same input state produces the same classification,
   the same impact analysis, the same replan decision — every time.

2. **No unnecessary replans.** Impact analysis and staleness checks prevent
   replanning when the plan is still valid. The loop is conservative: when
   in doubt, it replans (a no-op diff is cheap; a stale plan is expensive).

3. **Respect the user.** Protected commitments ensure the autonomous loop
   never silently moves work the user explicitly placed or is actively
   working on. Feedback-loop prevention stops the engine from fighting
   the user's manual decisions.

4. **Single notification per change set.** Related changes within a coalescing
   window are batched into one notification, preventing spam.

5. **Replans via existing path.** The trigger graph delegates to the same
   `space:planning` queue with `trigger: 'autonomous'`, so the same engine,
   persistence path, and optimistic concurrency guard serve both user clicks
   and autonomous passes.

---

## C. Architecture: the enhanced review pipeline

```
Event Log / DB State
        │
        ▼
┌───────────────────┐
│  TRIGGER GRAPH     │  event type → impact signal + affected-space query
│  (trigger-graph.ts)│
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ AFFECTED SPACES    │  user → timezone → date(s) → Space rows
│ (affected-spaces.ts│
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ IMPACT ANALYSIS    │  does the change affect the current plan?
│ (impact.ts)        │  → skip if no material impact
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ PLAN STALENESS     │  is the plan already stale from a newer event?
│ (staleness.ts)     │  → skip if plan is fresh
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ AUTONOMY POLICY    │  is this user's autonomy level sufficient?
│ (policy.ts)        │  are there protected commitments?
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ FEEDBACK-LOOP      │  was this task recently user-changed?
│ CHECK              │  → suppress if so
│ (feedback-loop.ts) │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ REPLAN (existing)  │  coalesce → enqueue → planning worker
│ (service.ts sink)  │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ NO-OP DETECTION    │  plan diff hasMeaningfulChange → skip persist
│ (diff.ts existing) │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ NOTIFICATION       │  batch related changes → single notification
│ BATCHING           │  classify priority (CRITICAL/IMPORTANT/NORMAL/SILENT)
│ (notification-     │
│  batching.ts)      │
└───────────────────┘
```

---

## D. Trigger graph

**Module:** `packages/autonomy/src/trigger-graph.ts`

Every `EventType` the system produces maps to exactly one `TriggerNode` that
describes:

| Field                  | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| `baseClassification`   | Default severity before impact analysis            |
| `reasonCode`           | Stable machine-readable name for the rule          |
| `resolutionStrategy`   | How to find the affected Space(s)                  |
| `requiresReplan`       | Whether this trigger should attempt replanning     |
| `requiresNotification` | Whether this trigger should produce a notification |
| `notificationPriority` | Default notification priority                      |

The mapping is total: unknown event types fall through to a conservative
default node (`NO_REPLAN`, no notification, no replan), so a newer producer
can never break an older loop.

**Replan triggers:** TASK_CREATED, TASK_UPDATED, TASK_COMPLETED,
TASK_RESCHEDULED, CALENDAR_CHANGED, CALENDAR_SYNCED.

**Review-only triggers:** TASK_MISSED, CALENDAR_CONNECTED,
CALENDAR_DISCONNECTED, CALENDAR_SYNC_FAILED, PLANNING_FAILED.

**No-action triggers:** PLANNING_COMPLETED, PLANNING_STARTED,
SPACE_CREATED, SPACE_UPDATED, SPACE_OPTIMIZED, DEADLINE_APPROACHING,
GOAL_CREATED, GOAL_ACHIEVED, all NOTIFICATION_* events, REMINDER_* events.

---

## E. Affected-space detection

**Module:** `packages/autonomy/src/affected-spaces.ts`

Resolves which Space(s) are potentially affected by an event, using the
trigger node's `resolutionStrategy`:

| Strategy        | Resolution                                                 |
| --------------- | ---------------------------------------------------------- |
| `EVENT_DATE`    | Task/Reminder → spaceId → Space, or scheduled date → Space |
| `CALENDAR_SYNC` | Calendar events in 72h horizon → dates → Spaces            |
| `USER_SCOPE`    | All DRAFT/ACTIVE spaces with plans (bounded to 10)         |
| `DEADLINE_SCAN` | Task's spaceId → Space                                     |

Every query is scoped by `userId`. No cross-user data access.

---

## F. Impact analysis

**Module:** `packages/autonomy/src/impact.ts`

Before enqueueing a replan, determines whether the change actually affects
the current plan. Seven signal detectors:

| Signal               | Detection logic                                         |
| -------------------- | ------------------------------------------------------- |
| `SCHEDULE_COLLISION` | Updated task overlaps another PLANNED task in the Space |
| `CALENDAR_DRIFT`     | Calendar events changed within the planning horizon     |
| `DEADLINE_RISK`      | Task's deadline may not be met by current placement     |
| `DEPENDENCY_BREAK`   | Other tasks depend on the changed task                  |
| `WORKLOAD_IMBALANCE` | >12 open tasks, or >3 open tasks with none planned      |
| `NEWLY_AVAILABLE`    | Task completed or cancelled; freed time may be reused   |
| `NEWLY_UNAVAILABLE`  | (Reserved for future: working-hours change)             |

When no signals are detected, `hasMaterialImpact` is false and the replan
is skipped. This is the primary no-op detection mechanism.

---

## G. Plan staleness model

**Module:** `packages/autonomy/src/staleness.ts`

Determines whether a plan is still fresh or needs regeneration:

- **planVersion=0**: always stale (never planned).
- **optimizedAt=null**: always stale.
- **Plan age > MAX_PLAN_AGE_MS**: unconditionally stale.
- **Plan age > STALENESS_THRESHOLD_MS**: potentially stale.

The staleness check is conservative: when in doubt, it returns "stale"
so the replan proceeds. False positives are cheap (no-op diff); false
negatives are expensive (stale plan).

---

## H. Autonomy policy enforcement

**Module:** `packages/autonomy/src/policy.ts`

Gates every autonomous action against the user's autonomy preference:

| Level                  | Behavior                                          |
| ---------------------- | ------------------------------------------------- |
| `SUGGEST_ONLY`         | Never writes; only records suggestions            |
| `ASK_BEFORE_CHANGING`  | Writes new placements, never moves existing items |
| `AUTOMATICALLY_MANAGE` | Full replan with all moves allowed                |

**Protected commitments** are tasks the user has explicitly interacted with:

- `USER_IN_PROGRESS`: Task set to IN_PROGRESS within the grace period
  (30 minutes).
- `USER_MOVED`: Task rescheduled by the user (TASK_RESCHEDULED event
  with `trigger: 'user'`) within the grace period.
- `USER_PLACED`: Task completed by the user within the grace period.

Protected tasks are passed to the replan so the engine can schedule around
them without moving them.

---

## I. Feedback-loop prevention

**Module:** `packages/autonomy/src/feedback-loop.ts`

Prevents the autonomous loop from fighting the user:

1. **Suppression window** (15 minutes): After a user-initiated change to a
   task, autonomous replans for that specific task are suppressed.
2. **Cycle detection**: Counts replan→user-change→replan cycles within a
   2-hour window. When the count reaches the escalation threshold (3),
   the cycle is flagged for review.
3. **Protected tasks**: The autonomy policy passes protected task IDs to the
   replan, so the engine schedules around them.

---

## J. Notification batching

**Module:** `packages/autonomy/src/notification-batching.ts`

When multiple changes occur within a coalescing window for the same Space,
they are grouped into a single notification:

- **Priority**: The batch's priority is the highest priority of any entry.
- **Truncation**: Batches are capped at 20 entries to prevent oversized
  notifications.
- **Merging**: Two batches for the same Space can be merged via
  `mergeBatches`.
- **Summary**: `summarizeBatch` produces a grouped human-readable summary
  (e.g., "Plan updated: 2 calendar changes, 1 task update.").

---

## K. Integration with existing infrastructure

### K.1 Existing phases preserved

The four existing review phases (missed blocks, deadline risk, calendar
drift, tomorrow planning) are unchanged. Phase 0 (trigger-graph scan)
runs first and handles event-driven replans. The existing phases continue
to handle their respective concerns.

### K.2 Planning worker

No changes to `apps/worker/src/queues/planning-worker.ts`. The trigger
graph delegates replans to the same `space:planning` queue with
`trigger: 'autonomous'`.

### K.3 Autonomy review worker

No changes to `apps/worker/src/queues/autonomy-review-worker.ts`. The
service's `review()` method now calls `runTriggerPhase()` first, then the
existing phases.

### K.4 Notification system

No changes to the notification outbox or sweep. The batching module
produces structured `NotificationBatch` objects that the service can use
when creating notification drafts.

---

## L. Concurrency and idempotency

| Mechanism           | Layer           | Purpose                                                    |
| ------------------- | --------------- | ---------------------------------------------------------- |
| Version CAS         | Planning worker | Prevents stale writes from overwriting newer plans         |
| BullMQ jobId        | Queue           | At most one pending replan per space per coalescing window |
| Per-pass dedup      | Service         | Same space never enqueued twice in one review pass         |
| Coalescing window   | Service         | Non-urgent replans dropped if space was recently optimized |
| Suppression window  | Feedback loop   | User-changed tasks not re-replanned for 15 minutes         |
| deliveryKey         | Notifications   | Same notification draft never created twice                |
| Trigger scan window | Phase 0         | Only events from the last 10 minutes are scanned           |

---

## M. Observability

Every autonomous decision is explainable through structured log fields:

```json
{
  "service": "autonomy",
  "spaceId": "...",
  "eventType": "TASK_UPDATED",
  "classification": "REPLAN_REQUIRED",
  "signals": 2,
  "triggerImpactSkipped": 0,
  "triggerFeedbackSuppressed": 0
}
```

The `ReviewSummary` returned by `review()` provides bounded metrics for
every phase and pipeline stage:

- `triggerEventsScanned` — events evaluated by the trigger graph
- `triggerReplansQueued` — replans enqueued via the trigger pipeline
- `triggerImpactSkipped` — replans skipped due to no material impact
- `triggerFeedbackSuppressed` — replans suppressed by feedback-loop check
- `triggerAutonomyDenied` — replans denied by autonomy policy
- `notificationsBatched` — notification entries batched

---

## N. Security

- All database queries are scoped by `userId` — no cross-user access.
- The trigger graph never exposes sensitive data in log messages.
- Protected commitments are resolved server-side, never from request bodies.
- The feedback-loop module reads only the event log and task state for the
  specified user.
- No new API surfaces were added; all new logic runs in the worker process.

---

## O. Testing

The `@space/autonomy` package has 105 tests across 9 files:

| File                            | Tests | Coverage                                                           |
| ------------------------------- | ----- | ------------------------------------------------------------------ |
| `change.test.ts`                | 15    | Event classification, monotonic ranking                            |
| `diff.test.ts`                  | 8     | All plan diff types, mixed diffs                                   |
| `service.test.ts`               | 6     | Service creation, missed detection, coalescing, trigger phase      |
| `trigger-graph.test.ts`         | 16    | All trigger nodes, forward compatibility, REPLAN/NOTIFICATION sets |
| `affected-spaces.test.ts`       | —     | (DB integration — covered by service tests)                        |
| `impact.test.ts`                | 16    | All 7 signal detectors, no-impact paths, material impact           |
| `staleness.test.ts`             | 16    | Staleness thresholds, fingerprint building                         |
| `policy.test.ts`                | 9     | Autonomy levels, protected commitments, user changes               |
| `feedback-loop.test.ts`         | 7     | Suppression, cycle detection, exclusion                            |
| `notification-batching.test.ts` | 12    | Batching, priority, merging, summarization                         |

The `service.test.ts` trigger-phase case drives the full Phase 0 path: an event
log scan resolves to an affected Space, impact/staleness/autonomy/feedback
gates pass, the replan is enqueued through the coalescing sink, and one
batched notification is created — asserting the `trigger*` and
`notificationsBatched` counters end up exactly right.

---

## P. Verification

All workspace checks pass:

- `pnpm typecheck` — clean (0 errors)
- `pnpm test` — 105/105 tests pass in `@space/autonomy`
- `pnpm lint` — clean across all packages
- `pnpm build` — clean across all packages
- `pnpm format:check` — clean

---

## Q. Known limitations and future work

1. **No task mutation UI.** The autonomous loop can classify and replan,
   but there is no API endpoint for users to create, edit, or complete
   tasks. That is a future stage.

2. **No new Prisma tables.** The loop operates over existing `Task`, `Space`,
   `PlanningPreferences`, `UserPreferences`, `EventLog`, and related models.

3. **Staleness model is conservative.** The current implementation uses
   plan age as the primary staleness signal. A more precise model would
   compare input fingerprints against stored hashes, but that requires
   a new column on the Space table.

4. **Feedback-loop detection is event-based.** It relies on events in the
   event log having `trigger: 'user'` in their payload. Events produced
   by the autonomous loop have `trigger: 'autonomous'`.

5. **Notification batching is per-review-pass.** Batches are assembled
   within a single review pass. Cross-pass batching would require
   persistent batch state.

6. **Protected commitment grace period is fixed.** The 30-minute grace
   period for user changes is hardcoded. A future stage could make it
   configurable per user.

7. **No weekend awareness in trigger phase.** The trigger-graph scan does
   not check `allowWeekendScheduling`. The engine's own `enforceWorkload`
   module handles weekend constraints during the pass.
