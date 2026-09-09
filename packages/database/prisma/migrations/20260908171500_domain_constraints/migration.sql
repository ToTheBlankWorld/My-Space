-- Domain invariants that Prisma's schema language cannot express.
--
-- These are CHECK constraints rather than application-level validation because
-- the database is the last line of defence: a background job, a psql session or
-- a future service must not be able to write a row the engines cannot read.

-- ---------------------------------------------------------------------------
-- space_items: an exclusive arc.
--
-- Exactly one of the three foreign keys is set, and it is the one that matches
-- `kind`. Without this, a row could claim to be a TASK while pointing at a
-- calendar event, and the timeline query would silently return nothing for it.
-- ---------------------------------------------------------------------------
ALTER TABLE "space_items"
  ADD CONSTRAINT "space_items_exactly_one_target"
  CHECK (
    (CASE WHEN "taskId" IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN "reminderId" IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN "calendarEventId" IS NULL THEN 0 ELSE 1 END)
    = 1
  );

ALTER TABLE "space_items"
  ADD CONSTRAINT "space_items_kind_matches_target"
  CHECK (
    ("kind" = 'TASK' AND "taskId" IS NOT NULL)
    OR ("kind" = 'REMINDER' AND "reminderId" IS NOT NULL)
    OR ("kind" = 'CALENDAR_EVENT' AND "calendarEventId" IS NOT NULL)
  );

ALTER TABLE "space_items"
  ADD CONSTRAINT "space_items_interval_ordered"
  CHECK ("scheduledEnd" IS NULL OR "scheduledStart" IS NULL OR "scheduledEnd" >= "scheduledStart");

-- ---------------------------------------------------------------------------
-- Times of day are minutes since local midnight, so they live in [0, 1440).
-- ---------------------------------------------------------------------------
ALTER TABLE "working_hours_blocks"
  ADD CONSTRAINT "working_hours_within_day"
  CHECK ("startMinute" >= 0 AND "startMinute" < 1440 AND "endMinute" > 0 AND "endMinute" <= 1440);

ALTER TABLE "working_hours_blocks"
  ADD CONSTRAINT "working_hours_ordered"
  CHECK ("startMinute" < "endMinute");

ALTER TABLE "user_preferences"
  ADD CONSTRAINT "user_preferences_minutes_within_day"
  CHECK (
    ("morningNotificationMinute" IS NULL OR ("morningNotificationMinute" >= 0 AND "morningNotificationMinute" < 1440))
    AND ("middayNotificationMinute" IS NULL OR ("middayNotificationMinute" >= 0 AND "middayNotificationMinute" < 1440))
    AND ("eveningNotificationMinute" IS NULL OR ("eveningNotificationMinute" >= 0 AND "eveningNotificationMinute" < 1440))
  );

ALTER TABLE "planning_preferences"
  ADD CONSTRAINT "planning_preferences_minutes_within_day"
  CHECK ("preferredPlanningMinute" IS NULL OR ("preferredPlanningMinute" >= 0 AND "preferredPlanningMinute" < 1440));

ALTER TABLE "planning_preferences"
  ADD CONSTRAINT "planning_preferences_durations_non_negative"
  CHECK (
    "defaultTaskDurationMinutes" >= 0
    AND "maxDailyFocusMinutes" >= 0
    AND "minBreakMinutes" >= 0
    AND "bufferMinutes" >= 0
  );

-- ---------------------------------------------------------------------------
-- Durations are never negative and scheduled intervals never run backwards.
-- ---------------------------------------------------------------------------
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_durations_non_negative"
  CHECK (
    ("estimatedMinutes" IS NULL OR "estimatedMinutes" >= 0)
    AND ("actualMinutes" IS NULL OR "actualMinutes" >= 0)
  );

ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_interval_ordered"
  CHECK ("scheduledEnd" IS NULL OR "scheduledStart" IS NULL OR "scheduledEnd" >= "scheduledStart");

ALTER TABLE "calendar_events"
  ADD CONSTRAINT "calendar_events_interval_ordered"
  CHECK ("endAt" >= "startAt");

-- A recurrence repeats at least every interval, and ends either at a date or
-- after a count, never both.
ALTER TABLE "reminders"
  ADD CONSTRAINT "reminders_recurrence_interval_positive"
  CHECK ("recurrenceInterval" IS NULL OR "recurrenceInterval" >= 1);

ALTER TABLE "reminders"
  ADD CONSTRAINT "reminders_recurrence_single_end"
  CHECK ("recurrenceUntil" IS NULL OR "recurrenceCount" IS NULL);

ALTER TABLE "productivity_snapshots"
  ADD CONSTRAINT "productivity_counts_non_negative"
  CHECK (
    "tasksPlanned" >= 0
    AND "tasksCompleted" >= 0
    AND "tasksMissed" >= 0
    AND "plannedMinutes" >= 0
    AND "completedMinutes" >= 0
  );

ALTER TABLE "email_logs"
  ADD CONSTRAINT "email_logs_retry_count_non_negative"
  CHECK ("retryCount" >= 0);
