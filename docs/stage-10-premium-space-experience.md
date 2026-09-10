# Stage 10 — The Premium Space Product Experience

This document records what Stage 10 built: the conversion of the Stages 1–9
platform into a complete, polished, daily-planner **product** — an app shell, a
day workspace, an overview dashboard, a notification center, a calendar center,
settings pages, design-system motion and loading semantics — all deterministic,
all explainable, with no AI/LLM anywhere in the experience.

- [A. Objective and scope](#a-objective-and-scope)
- [B. Design principles](#b-design-principles)
- [C. The product shell](#c-the-product-shell)
- [D. The day workspace](#d-the-day-workspace)
- [E. The overview dashboard](#e-the-overview-dashboard)
- [F. The notification center](#f-the-notification-center)
- [G. The calendar center](#g-the-calendar-center)
- [H. Settings](#h-settings)
- [I. Motion, loading and failure states](#i-motion-loading-and-failure-states)
- [J. Determinism and timezone discipline](#j-determinism-and-timezone-discipline)
- [K. Security and ownership](#k-security-and-ownership)
- [L. Accessibility](#l-accessibility)
- [M. Testing](#m-testing)
- [N. Verification](#n-verification)
- [O. Known limitations and future work](#o-known-limitations-and-future-work)

---

## A. Objective and scope

Stage 10 delivers the **premium product surface** on top of the existing engine.
Every earlier stage built backend capability: calendars, the planning engine,
Plan My Day, notifications, the autonomous loop. Stage 10 turns that capability
into screens a person actually uses every day.

In scope:

- **App shell** — persistent rail navigation, session guard, unread badge,
  Today anchor, sign-out.
- **Day workspace** — `GET /space/[date]`: header, Plan My Day, live timeline,
  task pool, schedule health, and an autonomy-change feed.
- **Overview dashboard** — `GET /dashboard`: greeting, 7-day week strip, work
  counts, quick links.
- **Notification center** — grouped, prioritized, per-row and bulk read.
- **Calendar center** — connection management and a seven-day event window.
- **Settings** — account, autonomy, notifications, planning defaults.
- **Design-system motion** — CSS entrance motion, JS-managed micro-interactions,
  per-route loading shells, error and not-found boundaries.
- **Web unit testing** — Vitest wired for the app, 15 tests over the pure
  timezone-honest helpers.
- **This document.**

Explicitly out of scope:

- **AI/LLM-generated anything.** No model is called; no "AI" copy appears in the
  product ("Plan my day", "Optimize Space" and similar deterministic labels
  instead).
- **New engine capabilities.** Stage 10 adds no planning, autonomy, notification
  or calendar backend behavior — only surfaces read and invoke the existing
  services through ownership-scoped composition roots and server actions.
- **Realtime in the UI.** Realtime notifications and calendar pushes remain
  server capabilities; the browser experience re-fetches on navigation and
  revalidates on mutation rather than holding websockets open.
- **Unknown routes.** A catch-all screen was deliberately not built; documented
  routes render, everything else 404s with the same quiet exit.

---

## B. Design principles

1. **Deterministic surfaces.** The pages render the authoritative engine state
   read back from the database. There is no client-side simulation, no derived
   truth, no "spinner first then correct it" optimistic planning.
2. **Every mutation is authoritative.** All writes happen in server actions or
   API routes that re-check the session, validate input, and revalidate the
   affected route. Client components call actions and refresh; they never mutate
   the database themselves.
3. **Ownership-scoped read surfaces.** Pages read through `server/*` composition
   roots (`getSpaceDayData`, `getOverview`, `getSettings`, `getCalendarSummary`)
   that only ever query the requesting user's rows, never the whole table.
4. **Rendering honours the space's timezone.** Labels derive from absolute
   calendar dates and instants rendered in `day.timeZone`, never the server's
   clock. This is tested, not asserted.
5. **No fake data, no template aesthetics.** Empty states describe reality with
   nothing invented. The visual language is neutral and typography-led — a warm
   accent on a near-monochrome palette — with hierarchy from spacing, weight and
   contrast rather than colour.
6. **Motion is earned and accessible.** Pure-CSS entrance animation that runs
   without JavaScript and is collapsed by the existing reduced-motion rule;
   JavaScript-driven animation only where it encodes state (a plan result
   appearing, a cancel confirmation swapping in).
7. **Loading and failure are designed, not defaulted.** Every authenticated
   route streams a shell-shaped skeleton with zero data reads; errors and 404s
   have honest, actionable pages.

---

## C. The product shell

Every authenticated screen renders inside `AppShell` (`components/app/app-shell.tsx`):

- **Session guard** — `requireOnboardedUser()` (from the existing auth session
  service) gates the entire shell; unauthenticated or un-onboarded users are
  redirected before any content composes.
- **Today anchor** — the "Today" nav item links to the user's current calendar
  date in *their* timezone (`getPlanningService().getToday(user.id)`), so the
  primary action is correct even when the server lives in another region.
- **Unread badge** — the rail pulls `getNotificationsService().unreadCount(user.id)`
  so the notification entry always shows live state.
- **Desktop rail** — a sticky `w-64` sidebar with the space mark, the primary
  navigation (`Overview`, `Today`, `Notifications`, `Calendar`, `Settings`), and
  a signed-in-as footer with sign-out.
- **Mobile header** — the same navigation in a compact horizontal strip.
- **Skip target** — the shell owns `<main id="main">`, so the root layout's
  skip link continues to land on real content rather than on a wrapper.

The loading counterpart, `AppLoading` (`components/app/app-loading.tsx`), mirrors
the rail so a navigation never flashes a bare page — and reads nothing, so it
streams immediately while the real page waits on its data.

---

## D. The day workspace

`GET /space/[date]` is the heart of the product. The page (`app/space/[date]/page.tsx`)
guards the date (a value that is not a calendar date is a 404), reads the day
through `getSpaceDayData(userId, date)`, and renders `DayWorkspace`
(`components/day/day-workspace.tsx`).

`server/space.ts` composes the day:

- `getDayState(...)` — the authoritative parsed day (timeline items, unscheduled
  pool, latest plan).
- `audit.listAgentActionsForSpace(db, userId, spaceId, { limit: 30 })` — the most
  recent autonomous changes, mapped to a presentation DTO (`AgentActionView`)
  with outcome, reason, and before/after starts.
- `users.findPlanningProfile(...)` — the user's autonomy level, defaulting to
  `ASK_BEFORE_CHANGING`.

### Header

Date navigation (previous / next calendar day, a **Today** anchor), the date as
*"Thursday 10 September"*, the user's autonomy mode as a static badge, and the
**Plan My Day** control.

`PlanMyDay` (`components/day/plan-my-day.tsx`) is the same deterministic control
from Stage 6, surfaced in-place: it POSTs `/api/plan`, shows a bounded summary
(`Planned · n placed · n still open · <mode>`), then refreshes the route so the
page re-renders from the persisted plan. The result readout is wrapped in a
client-side enter/exit animation and exposed as a polite live region.

### Timeline

`Timeline` renders the day's planned items against a bounded
hour scale (`timelineBounds` — padded around the earliest and latest instants,
defaulting to 08:00–18:00 on an empty day, clamped to the calendar day). On
today, a now-indicator is drawn at the current minute. Calendar events and
planned tasks carry their priority, time-of-day (rendered in the space's
timezone) and duration.

### Pool

The unscheduled task list (`components/day/pool.tsx`). Quick-create posts the
`createTask` server action and refreshes; each row is a `TaskRow` with priority,
state transitions, and a two-step cancel (cancel → inline confirmation →
"Cancel task"/"Keep", auto-dismissed after four seconds so an accidental tap is
not destructive).

### Schedule health

`ScheduleHealth` summarises the latest completed planning pass:

- **Focus** — minutes of work placed by the engine (`focusMinutes`, excludes
  calendar anchors),
- **Tasks placed** / **still open** from the plan's own counts,
- **Conflicts** found (zero, or a surfaced count),
- **Meetings** — calendar events on the timeline,

with a footer that names the plan revision, the mode that produced it, and the
space's timezone — the proof point for the no-AI claim: every number is the
engine's persisted, explainable output.

### Autonomy change feed

`AutonomyChanges` lists the most recent `AUTONOMY_*` actions the loop took
(action type, outcome tone, reason, previous → new scheduled time rendered via
`timeOf` in the space's timezone). It is a read of the audit log — the "what did
Space do and why" surface that makes autonomous behaviour understandable.

Panels enter with pure-CSS staggered motion (40/100/160 ms) via the global
`rise` animation and `--rise-delay`.

---

## E. The overview dashboard

`GET /dashboard` (`app/dashboard/page.tsx` + `server/overview.ts`) gives the user
a morning glance:

- **Greeting** — `Good <period>, <first name>` derived from the user's local hour.
- **7-day week strip** — today through the next six calendar days as chips, each
  showing whether that day has planned work (a dot from `spaces.listSpacesInRange`),
  linking into the corresponding day workspace.
- **Stat cards** — tasks placed today, overdue work, work with deadlines, unread
  notifications.
- **Quick links** — straight into `Today`, the calendar, or Settings.

The counts come from `work.countTasksForOverview(...)` (two `$transaction`
counts over open statuses) and the notification service; nothing is guessed from
the server timezone (the week strip is computed as absolute calendar dates).

---

## F. The notification center

`GET /notifications` reads through the existing `NotificationsService` (with its
new `page` support) and renders:

- items **grouped by their calendar day** in the space's timezone
  (`toCalendarDate(createdAt, tz)`),
- a per-type icon and a priority status dot,
- **Mark as read** per row (a `markNotificationRead` form action … `Promise<void>`,
  revalidating `/notifications`) and **Mark all read** — both plain,
  no-JavaScript-required forms.

This replaces the earlier custom mark-all handler with a single server action,
and drops rows into the same visual language as the rest of the shell.

---

## G. The calendar center

`GET /calendar` (`app/calendar/page.tsx` + `server/calendar-summary.ts`) is the
surface for the Stage 4 calendar integrations:

- **Connections** — each linked calendar (provider, account, sync status)
  rendered from safe selects that *never* include tokens; a **disconnect**
  control posts to `/api/calendar/disconnect` (best-effort revoke, mirrored
  events retained) and refreshes.
- **Connect** — a button only when Google OAuth is actually configured
  (`hasOAuthConfig` reads the config and guards an absent/malformed env rather
  than crashing); otherwise an honest "not configured" message.
- **Next seven days** — events from `calendar.listCalendarEventsInRange`,
  grouped by day, always computed against the space's timezone.

---

## H. Settings

`GET /settings` (`app/settings/page.tsx` + `server/settings.ts`) reads the
existing preferences (`users.findPlanningProfile`) and renders:

- **Account** — name, email, and the effective timezone (which lives on
  `user_preferences`, not planning preferences).
- **Autonomy level** — radio cards over `AUTONOMY_LEVELS` (Suggest only / Ask
  before changing / Automatic), each with its product definition.
- **Notification toggles** — in-app and email switches, each posting a dedicated
  server action (column-wise preference writes, avoiding the whole-object upsert
  pitfall of these preference schemas).
- **Planning defaults** — daily focus minutes, minimum break, and buffer
  duration, plus the working-hours week (Mon–Sun chips) labelled with
  `clockTime` in the space's own timezone.

---

## I. Motion, loading and failure states

Three complementary layers, chosen so that decoration never hides content:

1. **Pure-CSS entrance motion** — a single `rise` keyframe (opacity + a 12 px
   rise, 0.55 s) with a `--rise-delay` variable, applied to the day-workspace
   panels. It runs without JavaScript (server-rendered content is never
   JS-gated) and the existing global
   `@media (prefers-reduced-motion: reduce)` rule that collapses all animation
   (`animation-duration: 0.01ms !important`) already neutralizes it for reduced
   motion.
2. **JavaScript motion only where it encodes state** — the `motion` package
   (`motion/react`) powers two `AnimatePresence` transitions: the plan-result
   readout in `PlanMyDay` (`popLayout`, fade+rise) and the idle ↔ cancel-confirm
   swap in `TaskRow` (opacity+scale, 140 ms). Neither is load-bearing; JS is
   required only for the interactions that need it, and both remain accessible
   without animation.
3. **Shell states** —
   - each authenticated route ships `loading.tsx` re-exporting `AppLoading`, a
     skeleton silhouette of the shell with zero data reads;
   - root `error.tsx` is a client boundary that offers *Try again* without
     inventing details ("your account, plans and settings are untouched");
   - root `not-found.tsx` handles both unknown routes and invalid day URLs with
     a single calm 404 to the overview.

---

## J. Determinism and timezone discipline

`lib/day-view.ts` centralises the rendering helpers and carries the product's
correctness guarantees, all unit-tested (`lib/day-view.test.ts`):

- `timeOf(instant, tz)` — the same instant renders differently per timezone
  (e.g. `10:00 UTC` → `11:00` Lisbon, `06:00` New York, `15:30` Kolkata); null →
  `–`.
- `longDate(date)` — formats the **absolute calendar date** (UTC discipline),
  so headers and the week strip never shift with the server's region.
- `isTodayInZone`, `minuteOf`, `previousDate`, `nextDate` — day math and
  "today" always in the space's timezone.
- `timelineBounds` — pads/clamps the timeline span; `focusMinutes` counts placed
  work but never anchors; `durationLabel` and `clockTime` are pinned formats
  (including clamping `clockTime` to 00:00–23:59).

`Vitest` resolves the workspace’s TypeScript-source packages via `vitest.config.ts`
aliases so the helpers are tested as they are shipped.

---

## K. Security and ownership

- **Session enforcement** — every authenticated page and action resolves the
  session first (`requireOnboardedUser`); the shell owns this once, actions
  re-check per call.
- **Ownership-scoped reads** — the `server/*` composition roots query only the
  requesting user's spaces, tasks, notifications and connections.
- **No frontend-only authorization** — UI state is presentation only; the
  backend never trusts it.
- **Safe calendar selects** — connection reads strip tokens; OAuth availability
  is guarded (`try/catch`) so a missing cloud credential degrades to "not
  configured", never a crash.
- **Layered imports, lint-enforced** — the web eslint config forbids UI
  components from importing `@space/database` (or config/env/database modules)
  directly; only pages and server actions under `src/app` may reach the data
  layer. This keeps the proxy pattern honest without scattered one-off rules.

---

## L. Accessibility

- **Skip link** → the shell's `#main`, surviving every navigation.
- **Live regions** — the plan result and pool errors use `role="status"` /
  `aria-live="polite"`.
- **Keyboard** — all interactive controls are native buttons/links/forms; the
  cancel confirm is reachable and dismissible by keyboard.
- **Labels and semantics** — icon buttons carry `aria-label`s; status dots are
  labelled; empty states are sentences, not floating graphics.
- **Reduced motion** — one global rule collapses decorative animation.
- **Language** — labels are plain, specific product copy; no hype, no invented
  "AI can …" claims.

---

## M. Testing

- **Web unit tests (new this stage)** — `apps/web/src/lib/day-view.test.ts`:
  15 tests pinning timezone rendering, calendar-date formatting across year
  boundaries, day navigation, today-in-zone, minute-of-day, duration and
  clock-time formatting, timeline bounds (empty and padded), and focus-minute
  accounting. Ran under `pnpm --filter @space/web test` (Vitest).
- **Existing suites** — the engine, autonomy, planning, notifications, calendar,
  database repositories, auth, validation, time, types, logger, ui and worker
  packages retain their tests and remain green under the root `pnpm test`
  (which now includes `@space/web`).

---

## N. Verification

Executed from the repo root at the end of Stage 10:

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | 16/16 tasks pass |
| Lint | `pnpm lint` | 16/16 tasks pass |
| Tests | `pnpm test` | 16/16 packages pass (web included, 15 new tests) |
| Formatting | `pnpm format:check` | all matched files use Prettier style |
| Production build | `pnpm build:web` | exit 0 — compiled in 16.3s, 13/13 static pages generated, all 19 routes in the app table |

Route table confirms: `/` static; API routes (`/api/plan`, `/api/notifications*`,
`/api/calendar/*`, `/api/auth/*`) and `/calendar`, `/dashboard`, `/login`,
`/notifications`, `/onboarding`, `/settings`, `/space`, `/space/[date]` dynamic.

Two environmental caveats, stated honestly:

- The repo contains only `.env.example` files — no live credentials. The build
  succeeds without them, but authenticated e2e against a real database,
  Google OAuth, Redis scheduling and email delivery could not be exercised in
  this environment.
- The browser experience therefore could not be clicked through end-to-end here;
  correctness is verified at the type/lint/test/build level and by the
  ownership/authority discipline described above.

---

## O. Known limitations and future work

- **No drag-and-drop rescheduling in the UI.** Moving a task is a state
  transition through the authoritative engine; a direct-manipulation timeline
  editor (which would write via the engine, not around it) is natural follow-up.
- **Realtime is not reflected in the browser.** Notifications and calendar
  changes arrive on revalidation/navigation; an SSE/websocket adapter onto the
  existing realtime trigger graph is future work.
- **Calendar coverage is Google out of the box**, matching Stage 4; the
  connection surface is provider-shaped and ready for more.
- **Working-hours chips are the editable form of existing defaults but are
  displayed as a fixed Mon–Sun week**; locale-aware weeks and multi-range
  windows remain open.
- **New-user onboarding and the landing page** are unchanged from earlier
  stages; the Stage 10 shell assumed their existing flows.

Stage 10 makes the product feel finished: it surfaces the engine's
deterministic, explainable behaviour through a calm, accessible, motion-tight
shell — and proves it with a green, formatted, buildable workspace.