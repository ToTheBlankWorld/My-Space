# Stage 7 — Notification Engine + Outbox + Reminder Dispatcher

This document records what Stage 7 built: the background notification engine
that turns the Stage 6 audit trail into real, durable notifications — in-app
rows and (optionally) outbound email. It explains the deterministic policy, the
EventLog-as-outbox consumer, the reminder dispatcher, the single-sweep design,
email delivery idempotency, and what is verified locally versus what must run in
CI.

- [A. Objective and scope](#a-objective-and-scope)
- [B. Early decisions](#b-early-decisions)
- [C. Schema: notifications and the email log](#c-schema-notifications-and-the-email-log)
- [D. The policy: deterministic "what kind, how loud"](#d-the-policy-deterministic-what-kind-how-loud)
- [E. Templates: validated, HTML-safe, link-safe](#e-templates-validated-html-safe-link-safe)
- [F. Outbox consumption: PLANNING_COMPLETED as a queue](#f-outbox-consumption-planning_completed-as-a-queue)
- [G. The reminder dispatcher](#g-the-reminder-dispatcher)
- [H. The sweep: one deterministic job, four steps](#h-the-sweep-one-deterministic-job-four-steps)
- [I. Idempotency keys at every layer](#i-idempotency-keys-at-every-layer)
- [J. Email delivery and the provider abstraction](#j-email-delivery-and-the-provider-abstraction)
- [K. Crash recovery and the send-then-crash guard](#k-crash-recovery-and-the-send-then-crash-guard)
- [L. The email provider (AgentMail) and failure classification](#l-the-email-provider-agentmail-and-failure-classification)
- [M. Worker wiring: queue, sweep schedule, fan-out](#m-worker-wiring-queue-sweep-schedule-fan-out)
- [N. Web surface: inbox, unread badge, read APIs](#n-web-surface-inbox-unread-badge-read-apis)
- [O. Configuration](#o-configuration)
- [P. Testing strategy](#p-testing-strategy)
- [Q. Verification status](#q-verification-status)
- [R. Security review, performance and known limitations](#r-security-review-performance-and-known-limitations)

---

## A. Objective and scope

Stage 7 ships the notification engine promised at the end of Stage 6: a
**background pipeline that announces things the system already knows**, without
any polling or duplicate logic in the web tier.

In scope:

- The **EventLog as an outbox**: a durable consumer reads `PLANNING_COMPLETED`
  events and turns each into a _plan-change_ notification, idempotently and
  without reading the outbox's own writes.
- A **reminder dispatcher**: due `Reminder` rows become `task-reminder`
  notifications (with CRITICAL→IMPORTANT escalation), each occurrence keyed for
  exactly-once delivery.
- A **daily cycle**: per-user morning/midday slots produce a daily brief of open
  and completed tasks, gated by user preferences.
- A **single deterministic sweep** (`space:notification-sweep`) that reconciles
  daily cycles, dispatches reminders, consumes the outbox, and lines up due
  email deliveries — one repeatable BullMQ job, no per-user timers.
- **Email delivery** behind an `EmailProvider` abstraction (AgentMail default),
  with retries, permanent-failure dead-lettering, and a send-then-crash guard.
- A **minimal web surface**: `/notifications`, the unread badge counters, and
  read/read-all operations scoped by session.
- A substantial unit/worker test suite over an in-memory fake database.
- This document.

Explicitly out of scope:

- **AI-generated notifications.** Nothing here invokes a model; every decision
  is deterministic over stored facts.
- **Recurrence expansion, calendar writes, and a notification preferences UI.**
  The policy reads `userPreferences` but no screen edits it yet.
- **Provider webhook callbacks.** Email status _updates_ (`updateEmailStatus`)
  exist for a future callback route, but no endpoint is wired.
- Anything that pretends local infrastructure exists where it does not: live
  email, Postgres and Redis all remain CI-only (see [R](#r)).

---

## B. Early decisions

| Decision                                                                      | Why                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`@space/notifications` is server-only, queue-agnostic and broker-agnostic** | BullMQ and AgentMail credentials live in the worker; the package takes seams (`enqueueDelivery`, an `EmailProvider`) so every decision is unit-testable without Redis, Postgres or a network.                                               |
| **The EventLog is the outbox**                                                | Stage 6 already writes `PLANNING_COMPLETED`; re-notifying from another table would need the producer to commit two writes. Reading the append-only log gives an exactly-once source of truth with a physical cursor.                        |
| **The consumer never reads its own writes**                                   | The processor also writes `NOTIFICATION_CREATED` into the EventLog. `readEventOutbox` filters by event type and the cursor only ever advances over `PLANNING_COMPLETED`, so the processor can never loop on itself.                         |
| **One sweep per interval, not per user**                                      | Per-user timers explode into thousands of repeatable jobs. One sweep scans due reminders/briefs/deliveries in bounded batches; the planner's own event still says _who_ and _when_, so nothing needs a timer.                               |
| **Idempotency keys encode the thing being announced**                         | `daily:morning:{userId}:{date}`, `plan-change:{spaceId}:{v}`, `reminder:{id}:{occurrence}` — the key is the event's dedupe identity and its human-readable meaning at once, and the physical unique index makes a duplicate insert a no-op. |
| **Policy is pure; the sweep owns all side effects**                           | `evaluateDailyBrief` and friends take facts (never a clock, never a db handle). Every test of _what_ to send is therefore deterministic and trivially auditable.                                                                            |
| **Emails render at delivery time, from logged structured data**               | The `email_logs` table stores the template name and its bounded data, never the rendered HTML — a second copy of the user's own content in a log table is a leak waiting to happen.                                                         |
| **Provider errors are classified, not swallowed**                             | A 5xx is retryable with backoff; a 4xx is permanent and dead-letters immediately. A missing AgentMail key records `provider-not-configured` and moves on — email is never silently dropped or faked.                                        |

---

## C. Schema: notifications and the email log

Two new tables plus supporting indexes (migration
`20260910120000_stage7_notifications`, applied only in CI):

**`Notification`** — the in-app inbox row.

- `type` (`NotificationType`), `priority` (`NotificationPriority` from `SILENT`
  to `CRITICAL`), `title`, `body`.
- `deliveryState` (`PENDING → QUEUED → SENT | FAILED | SKIPPED`).
- `deliveryKey String? @unique` — the physical idempotency floor.
- `linkUrl String?` — a safe in-app deep link built by policy from `APP_URL`
  and validated entity ids only; never user-supplied.
- `readAt`, `scheduledAt`, `sentAt`, `failureReason`.
- Indexes: `(userId, createdAt desc)` for the inbox, `(userId, readAt)` for the
  unread badge, `(deliveryState, scheduledAt)` for the dispatcher.

**`EmailLog`** — one row per outbound attempt family.

- `recipient`, `template`, `provider`, `providerMessageId`, `status`
  (`QUEUED | SENT | DELIVERED | FAILED | BOUNCED`), `retryCount`, `sentAt`.
- `data Json?` — bounded structured template input, never rendered HTML.
- `notificationId User?` links back; `(provider, providerMessageId)` is unique
  so a status callback can find its row.

Repos live in `packages/database/src/repositories/delivery.ts`:
`createNotification`, `listNotifications`, `countUnreadNotifications`,
`markNotificationRead`/`markAllNotificationsRead`, `listDueNotifications`,
`listDispatchableNotifications`, `claimNotificationForDispatch`,
`markNotificationSent`/`markNotificationFailed`/`markNotificationSkipped`,
`recordEmail`, `updateEmailStatus`, `updateEmailAttempt`,
`findOutcomeEmailForNotification`. Audit helpers for the outbox live in
`repositories/audit.ts` (`readEventOutbox`).

---

## D. The policy: deterministic "what kind, how loud"

`packages/notifications/src/policy.ts` exports pure functions. None call a
clock, read the database, or import UI. Signature pattern:
`evaluateX(facts, settings, getOptions)` → a draft or `null` (nothing to send).

- **`evaluateDailyBrief`** — given open/scheduled/completed task counts and the
  user's `DailyCycleFacts`, decides whether today's slot deserves a brief and
  what it says, for a `DAILY_SLOTS` slot (`morning`, `midday`).
- **`evaluateDeadlineWarning`** — a task whose `dueAt` is today and still open.
- **`evaluateTaskMissed`** — a task that passed its scheduled window uncompleted.
- **`evaluatePlanCompletion`** — a `PLANNING_COMPLETED` event compared against
  the previous completed-plan summary for the same user+space; drafts only when
  the plan actually changed, so a replay produces silence.

Every draft carries a `deliveryKey` (built by `keys.ts`), a `linkUrl` (from the
`appUrl` parameter), and an `email` directive when an email is warranted. The
master switch `notificationsEnabled` gates drafting entirely; the per-type
email flag gates only the `EmailLog` leg (`deliveryState SKIPPED` /
`in-app-only`).

---

## E. Templates: validated, HTML-safe, link-safe

`packages/notifications/src/templates.ts` is a dependency-free renderer. Its
rules are explicit and test-pinned:

- Every template declares a Zod schema; `renderEmail(template, data, appUrl)`
  parses the data and throws on an unknown template or a schema violation, so a
  malformed `EmailLog` row can never render garbage.
- **Dynamic content is escaped at interpolation sites** (`escapeHtml`); static
  markup is authored, not produced from data. Subjects are written as plain MIME
  headers to the `email_logs`-derived fields; the HTML `<h1>` re-escapes the same
  value.
- `paragraph()` is deliberately raw passthrough of _trusted_ composed HTML —
  the surrounding string interpolation sites are what escape.
- Only same-origin `https` links (rooted at `appUrl`) may appear; policy builds
  `linkUrl` from validated entity ids, never from user input.
- Rendering is UTC-deterministic; date formatting (`formatDate`) is fixed.
- `TEMPLATE_NAMES`: `morning-brief`, `midday-pulse`, `plan-changed`,
  `deadline-warning`, `task-missed`, `task-reminder`.

---

## F. Outbox consumption: PLANNING_COMPLETED as a queue

`packages/notifications/src/outbox.ts` (`consumeOutbox`) implements the pattern:

1. `readEventOutbox(db, { afterSequence, eventType: 'PLANNING_COMPLETED' })`
   reads a bounded batch strictly after the cursor, **only** `PLANNING_COMPLETED`
   events. The cursor starts `null` (`sequence gt 0`).
2. For each event, `evaluatePlanCompletion` reads the user's previous completed
   plan summary via `readPreviousSummary` (same user+space, `sequence lt`
   current, also `PLANNING_COMPLETED`) and drafts only if the summary actually
   changed.
3. Drafts are persisted — notification + optional email log — **inside one
   `$transaction`**, together with the cursor advance (a no-op event still
   advances the cursor). Effects and cursor advance are atomic.
4. A `UniqueConstraintError` on `deliveryKey` is a replay of an already-applied
   event: the cursor still advances — at-least-once, made safe by the unique
   index.

The processor also writes `NOTIFICATION_CREATED` and `REMINDER_TRIGGERED`
events into the same EventLog (for audit/agent-action continuity). Because the
reader filters by event type and the cursor only tracks `PLANNING_COMPLETED`,
the processor can never consume its own writes — the scan stays bounded and
terminates.

---

## G. The reminder dispatcher

`packages/notifications/src/reminders.ts` (`dispatchReminders`):

- Reads due, un-supported reminders (`nextRunAt <= now`, `OR` forced-run)
  ordered deterministically, in bounded batches.
- Loads each reminder's sibling reminder (Gruber) and its task through
  include-enabled reads.
- Applies the groundwork window: a reminder scheduled before its task's start
  is held back in small steps (`holdBackMinutes`, default `HOLD_BACK_6M`) until
  it falls inside the window, so a "before start" reminder retries next sweep
  without overscheduling.
- A **CRITICAL** task escalates its reminder to `IMPORTANT` priority.
- Each occurrence is keyed `reminder:{id}:{occurrence}` (occurrence is the
  actual-run counter, incremented transactionally) — a reprocessed reminder
  cannot double-notify.
- Every notification writes a `REMINDER_TRIGGERED` event plus the
  `NOTIFICATION_CREATED`/`REMINDER_DISPATCHED` agent action.

---

## H. The sweep: one deterministic job, four steps

`packages/notifications/src/sweep.ts` (`runSweep`) is the deterministic
interval:

1. **Daily-cycle reconcile** (`reconcileDailyCycles`) — for users with a slot
   minute configured and `notificationsEnabled`, seed today's brief drafts keyed
   by `daily:{slot}:{userId}:{date}`. Tomorrow-planned logic: a slot scheduled
   for a _future_ day still seeds with the slot's date so the notification
   surfaces when its time arrives. Seeding writes the notification and, when the
   user has email on, an `EmailLog` row — both inside the same transaction,
   both idempotency-keyed.
2. **Reminder dispatch** — see [G](#g).
3. **Outbox consumption** — see [F](#f).
4. **Prepare deliveries** (`prepareDeliveries`) —
   - PENDING due + priority > SILENT → flip to `QUEUED` (compare-and-swap) and
     `enqueueDelivery()` one job; if enqueueing fails, revert to `PENDING`.
   - No email log for a PENDING notification → mark `SKIPPED` (`in-app-only`).
   - A stale QUEUED row with no log → counted `staleWithoutLog` for manual
     review.
   - A terminal `SENT`/`DELIVERED`/`BOUNCED` email log reconciles the
     notification state.
   - Provider unconfigured → rows stay `PENDING`, counted `providerUnconfigured`.

`runSweep` returns a bounded `SweepResult` the worker logs and the tests assert.

---

## I. Idempotency keys at every layer

| Key                                      | Meaning                            |
| ---------------------------------------- | ---------------------------------- |
| `daily:{slot}:{userId}:{date}`           | exactly one brief per slot per day |
| `plan-change:{spaceId}:{planVersion}`    | one change notice per plan version |
| `deadline:{taskId}:{dueDate}`            | one warning per task deadline      |
| `task-missed:{taskId}:{missedDate}`      | one missed notice per date         |
| `reminder:{id}:{occurrence}`             | one notice per reminder occurrence |
| `delivery:{emailLogId}` (BullMQ `jobId`) | one queue job per log row          |

The `@unique` index on `deliveryKey` is the physical floor: even a replayed
outbox batch, a concurrent sweep, or a redelivered BullMQ job cannot create a
second row.

---

## J. Email delivery and the provider abstraction

`packages/notifications/src/service.ts` (`deliverQueuedEmail`) is the
queue-independent delivery core the worker calls:

1. Re-read the notification by id (missing → `not-found`).
2. **Idempotency guard first**: `findOutcomeEmailForNotification` — the
   "has this notification already been accepted?" terminal check that makes
   send-then-crash safe. A terminal email exists → mark the notification SENT
   and return `idempotent-sent` without ever calling the provider again.
3. Unknown template or schema-failing data → permanent failure without a
   provider call.
4. `provider.send(...)`, then persist `SENT` on the log and notification, write
   `NOTIFICATION_SENT` event + `NOTIFICATION_DISPATCHED` agent action.
5. Provider failure: transient → throw `RetryableDeliveryError` (BullMQ backs
   off and retries); permanent → mark FAILED, write the failing audit trail, and
   return `failed-permanent`.

`EmailProvider` (`provider.ts`) is a two-member interface (`name`, `send`); the
default is AgentMail. Deps for a delivery attempt are narrowed to
`DeliveryAttemptDeps` (`db`, `clock`, `logger`, `appUrl`, `provider`) so the
worker can hand a plain object without sweep plumbing.

---

## K. Crash recovery and the send-then-crash guard

Two distinct crash windows and their guards:

- **Crash between claim and queue.add.** A QUEUED row whose delivery job was
  never registered goes stale (`updatedAt` older than
  `staleQueuedAfterMinutes`, default 10). `listDispatchableNotifications` picks
  it up, `prepareDeliveries` re-enqueues it with the deterministic `jobId`,
  which BullMQ dedupes if a job already exists.
- **Crash between provider accept and persistence.** The provider accepted the
  message but the SENT write never landed. On retry,
  `findOutcomeEmailForNotification` sees _something_ terminal and short-circuits
  to `idempotent-sent`, so the recipient is never emailed twice.

The `failed` hook on the worker finalizes the last attempt:
`finalizeFailedDelivery` sets FAILED and writes the terminal audit trail, so a
notification never sits QUEUED forever.

---

## L. The email provider (AgentMail) and failure classification

`packages/notifications/src/provider.ts`:

- POST `<baseUrl>/v1/messages` with a Bearer token; response shape is parsed
  with Zod; a success without a `message.id` is a permanent provider failure.
- `classifyProviderHttpError`: `401/403` → permanent `(auth)`, `5xx`/`429` →
  transient with the provider's message surfaced (nested `error.message`
  handled).
- `createEmailProvider(config)` returns `null` when no token is configured —
  delivery is genuinely disabled, never faked.

---

## M. Worker wiring: queue, sweep schedule, fan-out

`apps/worker/src/queues/notification-worker.ts` owns the `space:notifications`
queue with two job kinds (`NotificationJobPayload`):

- `{ kind: 'sweep' }` — runs `runSweep` and fans out one
  `{ kind: 'delivery', ... }` per prepared email via `enqueueDelivery`, each with
  `jobId: delivery:{emailLogId}`.
- `{ kind: 'delivery', notificationId, emailLogId }` — calls
  `deliverQueuedEmail`; a `RetryableDeliveryError` rethrows for BullMQ backoff;
  the `failed` hook finalizes after the last attempt.

`scheduleNotificationSweep` (`scheduler.ts`) registers the single repeatable
job `space:notification-sweep` at the `NOTIFICATION_SWEEP_INTERVAL_MINUTES`
cadence; deterministic `jobId` means a fleet of workers holds exactly one
schedule. Bootstrap starts the worker only when the database is present, and
constructs the provider from `AGENTMAIL_API_KEY`/`AGENTMAIL_BASE_URL`, passing
`APP_URL` for links. Shutdown closes the worker and the queue with the rest.

---

## N. Web surface: inbox, unread badge, read APIs

All read/acknowledge work is ownership-scoped by the session (cookie → user id),
never by any client-supplied handle:

- **`GET /api/notifications`** — newest-first page plus the unread count;
  `?unread=1` filters. The payload is shaped to safe fields only — the email log
  and provider internals are never exposed.
- **`POST /api/notifications/read`** — `{ id }` or `{ all: true }`; single marks
  return whether the row was actually flipped (preserving the original read
  time), `all` returns the count.
- **`/notifications`** — a server-rendered page (`requireOnboardedUser`,
  force-dynamic) with a no-JavaScript "Mark all as read" form action
  (`mark-all-read.ts`), and a Notifications link in `AuthHeader`.

`apps/web/src/server/notifications.ts` is the thin composition root wrapping
`@space/database`'s read/read-all repos with the app clock.

---

## O. Configuration

`@space/config/src/worker.ts` (defaults safe for a boot with no `.env`):

| Variable                              | Default                     | Meaning                                                |
| ------------------------------------- | --------------------------- | ------------------------------------------------------ |
| `APP_URL`                             | `http://localhost:3000`     | base for clickable links                               |
| `AGENTMAIL_API_KEY`                   | unset (optional)            | provider auth; absent ⇒ delivery disabled, never faked |
| `AGENTMAIL_BASE_URL`                  | `https://api.agentmail.dev` | provider endpoint (sandboxable)                        |
| `NOTIFICATION_SWEEP_INTERVAL_MINUTES` | `5` (`1..60`)               | sweep cadence                                          |

`apps/worker/.env.example` documents all four.

---

## P. Testing strategy

`@space/notifications` runs **66 unit/worker tests across 8 files**, all green
locally, over `packages/notifications/src/testing/fake-database.ts` — an
in-memory Prisma-shaped database that implements transactions, order-by
(including single-object form), nulls ordering, auto ids/sequences, `include`,
unique-constraint errors, and `readEventOutbox` cursor semantics.

Coverage by area:

- **policy.test.ts** — draft/no-draft paths, settings gates, escalation, pure
  brand types (`asCalendarDate`/`asTimeZone`) on inputs.
- **templates.test.ts** — schema rejection, escaping, same-origin-link rule,
  raw subject vs escaped `<h1>`, unknown-template throw.
- **provider.test.ts** — HTTP send contract, 401/403/permanent classification,
  nested error reading, empty-token ⇒ null provider.
- **outbox.test.ts** — batch consumption, cursor advance on no-op and on
  unrelated event types (read-agnostic filter), duplicate-key replay no-op,
  previous-summary change detection (v3/v4/v5 replay ⇒ silence).
- **reminders.test.ts** — dispatch, forced-run, CRITICAL→IMPORTANT escalation,
  hold-back window, occurrence-key uniqueness, events + agent actions written.
- **daily.test.ts** — reconcileDailyCycles slot seeding (incl. tomorrow-planned
  and prefs-off paths) and prepareDeliveries classification (prepared /
  in-app-only / provider-unconfigured / stale-without-log / revert).
- **delivery.test.ts** — sent path with events, transient retry, permanent
  dead-letter, send-then-crash idempotency, unknown-template dead-letter,
  finalize.
- **service.test.ts** — end-to-end `runSweep` over a seeded user: keys for all
  four artifact classes present, email logs written, outbox events consumed.

The tests also serve as the reliability harness for the fake itself — the two
subtle bugs fixed this session (fake `replace()` not advancing shared
id/sequence counters, and single-object `orderBy` being ignored) were found by
failing tests, not the other way around.

---

## Q. Verification status

Verified locally (run from the workspace root):

```
pnpm --filter @space/notifications lint        # clean
pnpm --filter @space/notifications typecheck   # clean
pnpm --filter @space/notifications test        # 66 passed / 8 files
pnpm --filter @space/database typecheck        # clean (audit eventType filter)
pnpm --filter @space/config typecheck          # clean (worker env)
pnpm --filter @space/worker lint + typecheck   # clean (queue/worker/scheduler)
pnpm --filter @space/web lint + typecheck      # clean (routes, page, service)
```

CI-only (cannot run locally — no Postgres/Redis/AgentMail/Docker/Playwright):

- `prisma migrate deploy` against the Stage 7 migrations.
- Live agents: BullMQ sweep scheduling, queue fan-out, delivery retries and
  dead-lettering against a real Redis.
- Actual AgentMail delivery and any e2e browser tests.
- `pnpm lint && typecheck && test && build && format:check` across the workspace
  (the integration test suite of `@space/database` likewise needs Postgres).

---

## R. Security review, performance and known limitations

**Security**

- Row ownership is enforced at query time and pinned to the session user id;
  API reads never accept a user or resource id from the client as proof.
- `linkUrl` is policy-built from `APP_URL` and validated entity ids — no open
  redirect and no arbitrary scheme.
- The email log stores template name + bounded structured data, **never** the
  rendered HTML or secrets; provider tokens stay in worker config and `pino`
  redacts the wire; nothing logs an API key.
- HTML escaping happens at every dynamic interpolation site; subjects are plain
  MIME headers; unknown template/data rows fail closed (dead-letter).
- SQL injection surface is zero (Prisma parameterization); pagination is
  bounded by `resolveLimit`.

**Performance**

- Unread badge is a `count` on `(userId, readAt)`, never a fetch-and-length.
- All dispatcher reads are bounded, index-assisted batches; the unique
  `deliveryKey` index is the dedupe floor regardless of batch size.
- One sweep job per interval; delivery jobs are one per email with deduped
  `jobId`s.
- Background scan is a `gt cursor` seek, not a full table scan, and unrelated
  event types are not even read.

**Known limitations (honest)**

- `notificationsEnabled`/`emailNotificationsEnabled` are read from
  `userPreferences`, but **no editing UI exists yet**.
- Deadlines and missed tasks are evaluated on the sweep cadence only — a task
  whose `dueAt` passes between sweeps is noticed at the next sweep.
- Email "DELIVERED"/"BOUNCED" statuses have repos (`updateEmailStatus`) but no
  webhook route is wired, so outbound status stays as recorded by the send call.
- The reminder implementation targets one task-to-reminder mapping; Gruber
  sibling logic is applied in a guard-clause form and is a candidate for deeper
  property-based testing in a later stage.
- No local Postgres/Redis/AgentMail/Playwright: everything involving a live
  dependency is exercised only in CI (section Q).

---

EOF
