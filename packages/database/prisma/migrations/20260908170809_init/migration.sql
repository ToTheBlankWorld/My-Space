-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "AutonomyLevel" AS ENUM ('MANUAL', 'ASSISTED', 'AUTOMATIC');

-- CreateEnum
CREATE TYPE "SchedulingStrategy" AS ENUM ('EARLIEST_FIT', 'BALANCED', 'DEADLINE_FIRST');

-- CreateEnum
CREATE TYPE "Weekday" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateEnum
CREATE TYPE "SpaceStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SpaceItemKind" AS ENUM ('TASK', 'REMINDER', 'CALENDAR_EVENT');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('CRITICAL', 'HIGH', 'NORMAL', 'LOW');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('INBOX', 'PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'MISSED', 'RESCHEDULED');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED', 'MISSED');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('PENDING', 'QUEUED', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "RecurrenceFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('ACTIVE', 'ACHIEVED', 'PAUSED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "CalendarProvider" AS ENUM ('GOOGLE');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "CalendarEventStatus" AS ENUM ('CONFIRMED', 'TENTATIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncState" AS ENUM ('SYNCED', 'PENDING_PUSH', 'PENDING_PULL', 'CONFLICT', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('DAILY_PLAN', 'TASK_REMINDER', 'DEADLINE_WARNING', 'SCHEDULE_CHANGE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('CRITICAL', 'IMPORTANT', 'NORMAL', 'SILENT');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED');

-- CreateEnum
CREATE TYPE "AgentActionType" AS ENUM ('SPACE_PLANNED', 'TASK_SCHEDULED', 'TASK_RESCHEDULED', 'TASK_DEFERRED', 'CONFLICT_RESOLVED', 'WORKLOAD_BALANCED', 'DEADLINE_ENFORCED', 'CALENDAR_RECONCILED', 'NOTIFICATION_DISPATCHED');

-- CreateEnum
CREATE TYPE "AgentActionOutcome" AS ENUM ('SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('SPACE_CREATED', 'SPACE_UPDATED', 'SPACE_OPTIMIZED', 'TASK_CREATED', 'TASK_UPDATED', 'TASK_COMPLETED', 'TASK_MISSED', 'TASK_RESCHEDULED', 'REMINDER_CREATED', 'REMINDER_TRIGGERED', 'DEADLINE_APPROACHING', 'GOAL_CREATED', 'GOAL_ACHIEVED', 'CALENDAR_CHANGED', 'NOTIFICATION_SENT');

-- CreateEnum
CREATE TYPE "AggregateType" AS ENUM ('USER', 'SPACE', 'TASK', 'REMINDER', 'GOAL', 'CALENDAR_EVENT', 'NOTIFICATION');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "name" TEXT,
    "imageUrl" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastSeenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "morningNotificationMinute" INTEGER,
    "middayNotificationMinute" INTEGER,
    "eveningNotificationMinute" INTEGER,
    "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planning_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "defaultTaskDurationMinutes" INTEGER NOT NULL DEFAULT 30,
    "preferredPlanningMinute" INTEGER,
    "schedulingStrategy" "SchedulingStrategy" NOT NULL DEFAULT 'BALANCED',
    "autonomyLevel" "AutonomyLevel" NOT NULL DEFAULT 'ASSISTED',
    "maxDailyFocusMinutes" INTEGER NOT NULL DEFAULT 360,
    "minBreakMinutes" INTEGER NOT NULL DEFAULT 10,
    "bufferMinutes" INTEGER NOT NULL DEFAULT 5,
    "allowWeekendScheduling" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "planning_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "working_hours_blocks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekday" "Weekday" NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "working_hours_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spaces" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "timeZone" TEXT NOT NULL,
    "status" "SpaceStatus" NOT NULL DEFAULT 'DRAFT',
    "summary" TEXT,
    "plannedAt" TIMESTAMPTZ(3),
    "optimizedAt" TIMESTAMPTZ(3),
    "planVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_items" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "SpaceItemKind" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "taskId" TEXT,
    "reminderId" TEXT,
    "calendarEventId" TEXT,
    "scheduledStart" TIMESTAMPTZ(3),
    "scheduledEnd" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "space_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT,
    "goalId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "notes" TEXT,
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "TaskStatus" NOT NULL DEFAULT 'INBOX',
    "estimatedMinutes" INTEGER,
    "actualMinutes" INTEGER,
    "dueAt" TIMESTAMPTZ(3),
    "scheduledStart" TIMESTAMPTZ(3),
    "scheduledEnd" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT,
    "taskId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "remindAt" TIMESTAMPTZ(3) NOT NULL,
    "timeZone" TEXT NOT NULL,
    "status" "ReminderStatus" NOT NULL DEFAULT 'PENDING',
    "deliveryState" "DeliveryState" NOT NULL DEFAULT 'PENDING',
    "deliveredAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,
    "recurrenceFrequency" "RecurrenceFrequency",
    "recurrenceInterval" INTEGER,
    "recurrenceByWeekday" "Weekday"[],
    "recurrenceUntil" TIMESTAMPTZ(3),
    "recurrenceCount" INTEGER,
    "parentId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "GoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "targetDate" DATE,
    "achievedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "CalendarProvider" NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "grantedScopes" TEXT,
    "syncCursor" TEXT,
    "lastSyncedAt" TIMESTAMPTZ(3),
    "lastErrorAt" TIMESTAMPTZ(3),
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calendar_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendars" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "timeZone" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isSelected" BOOLEAN NOT NULL DEFAULT true,
    "color" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT,
    "provider" "CalendarProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalEtag" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "timeZone" TEXT NOT NULL,
    "isAllDay" BOOLEAN NOT NULL DEFAULT false,
    "status" "CalendarEventStatus" NOT NULL DEFAULT 'CONFIRMED',
    "syncState" "SyncState" NOT NULL DEFAULT 'SYNCED',
    "lastSyncedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMPTZ(3),
    "deliveryState" "DeliveryState" NOT NULL DEFAULT 'PENDING',
    "scheduledAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "recipient" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "failureReason" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_actions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT,
    "actionType" "AgentActionType" NOT NULL,
    "outcome" "AgentActionOutcome" NOT NULL DEFAULT 'SUCCEEDED',
    "entityType" "AggregateType",
    "entityId" TEXT,
    "reason" TEXT NOT NULL,
    "factors" JSONB NOT NULL DEFAULT '{}',
    "previousState" JSONB,
    "resultingState" JSONB,
    "correlationId" TEXT,
    "durationMs" INTEGER,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_logs" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "eventType" "EventType" NOT NULL,
    "userId" TEXT NOT NULL,
    "aggregateType" "AggregateType" NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlationId" TEXT,
    "causationId" TEXT,

    CONSTRAINT "event_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "productivity_snapshots" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "timeZone" TEXT NOT NULL,
    "tasksPlanned" INTEGER NOT NULL DEFAULT 0,
    "tasksCompleted" INTEGER NOT NULL DEFAULT 0,
    "tasksMissed" INTEGER NOT NULL DEFAULT 0,
    "plannedMinutes" INTEGER NOT NULL DEFAULT 0,
    "completedMinutes" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "productivity_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_createdAt_idx" ON "users"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_userId_key" ON "user_preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "planning_preferences_userId_key" ON "planning_preferences"("userId");

-- CreateIndex
CREATE INDEX "working_hours_blocks_userId_weekday_idx" ON "working_hours_blocks"("userId", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "working_hours_blocks_userId_weekday_startMinute_key" ON "working_hours_blocks"("userId", "weekday", "startMinute");

-- CreateIndex
CREATE INDEX "spaces_userId_date_idx" ON "spaces"("userId", "date" DESC);

-- CreateIndex
CREATE INDEX "spaces_userId_status_idx" ON "spaces"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "spaces_userId_date_key" ON "spaces"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "space_items_taskId_key" ON "space_items"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "space_items_reminderId_key" ON "space_items"("reminderId");

-- CreateIndex
CREATE UNIQUE INDEX "space_items_calendarEventId_key" ON "space_items"("calendarEventId");

-- CreateIndex
CREATE INDEX "space_items_spaceId_position_idx" ON "space_items"("spaceId", "position");

-- CreateIndex
CREATE INDEX "space_items_spaceId_scheduledStart_idx" ON "space_items"("spaceId", "scheduledStart");

-- CreateIndex
CREATE INDEX "tasks_spaceId_status_priority_idx" ON "tasks"("spaceId", "status", "priority");

-- CreateIndex
CREATE INDEX "tasks_userId_status_dueAt_idx" ON "tasks"("userId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_userId_dueAt_idx" ON "tasks"("userId", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_userId_scheduledStart_idx" ON "tasks"("userId", "scheduledStart");

-- CreateIndex
CREATE INDEX "tasks_goalId_idx" ON "tasks"("goalId");

-- CreateIndex
CREATE INDEX "reminders_deliveryState_remindAt_idx" ON "reminders"("deliveryState", "remindAt");

-- CreateIndex
CREATE INDEX "reminders_userId_remindAt_idx" ON "reminders"("userId", "remindAt");

-- CreateIndex
CREATE INDEX "reminders_spaceId_idx" ON "reminders"("spaceId");

-- CreateIndex
CREATE INDEX "reminders_taskId_idx" ON "reminders"("taskId");

-- CreateIndex
CREATE INDEX "reminders_parentId_idx" ON "reminders"("parentId");

-- CreateIndex
CREATE INDEX "goals_userId_status_idx" ON "goals"("userId", "status");

-- CreateIndex
CREATE INDEX "calendar_connections_status_lastSyncedAt_idx" ON "calendar_connections"("status", "lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_connections_userId_provider_providerAccountId_key" ON "calendar_connections"("userId", "provider", "providerAccountId");

-- CreateIndex
CREATE INDEX "calendars_userId_isSelected_idx" ON "calendars"("userId", "isSelected");

-- CreateIndex
CREATE UNIQUE INDEX "calendars_connectionId_externalId_key" ON "calendars"("connectionId", "externalId");

-- CreateIndex
CREATE INDEX "calendar_events_userId_startAt_idx" ON "calendar_events"("userId", "startAt");

-- CreateIndex
CREATE INDEX "calendar_events_calendarId_startAt_idx" ON "calendar_events"("calendarId", "startAt");

-- CreateIndex
CREATE INDEX "calendar_events_syncState_lastSyncedAt_idx" ON "calendar_events"("syncState", "lastSyncedAt");

-- CreateIndex
CREATE INDEX "calendar_events_spaceId_idx" ON "calendar_events"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_events_calendarId_externalId_key" ON "calendar_events"("calendarId", "externalId");

-- CreateIndex
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

-- CreateIndex
CREATE INDEX "notifications_deliveryState_scheduledAt_idx" ON "notifications"("deliveryState", "scheduledAt");

-- CreateIndex
CREATE INDEX "email_logs_userId_createdAt_idx" ON "email_logs"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "email_logs_status_createdAt_idx" ON "email_logs"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_logs_provider_providerMessageId_key" ON "email_logs"("provider", "providerMessageId");

-- CreateIndex
CREATE INDEX "agent_actions_userId_occurredAt_idx" ON "agent_actions"("userId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "agent_actions_spaceId_occurredAt_idx" ON "agent_actions"("spaceId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "agent_actions_correlationId_idx" ON "agent_actions"("correlationId");

-- CreateIndex
CREATE INDEX "event_logs_sequence_idx" ON "event_logs"("sequence");

-- CreateIndex
CREATE INDEX "event_logs_userId_occurredAt_idx" ON "event_logs"("userId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "event_logs_aggregateType_aggregateId_occurredAt_idx" ON "event_logs"("aggregateType", "aggregateId", "occurredAt");

-- CreateIndex
CREATE INDEX "event_logs_eventType_occurredAt_idx" ON "event_logs"("eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "event_logs_correlationId_idx" ON "event_logs"("correlationId");

-- CreateIndex
CREATE INDEX "productivity_snapshots_userId_date_idx" ON "productivity_snapshots"("userId", "date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "productivity_snapshots_userId_date_key" ON "productivity_snapshots"("userId", "date");

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_preferences" ADD CONSTRAINT "planning_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_hours_blocks" ADD CONSTRAINT "working_hours_blocks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_items" ADD CONSTRAINT "space_items_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_items" ADD CONSTRAINT "space_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_items" ADD CONSTRAINT "space_items_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_items" ADD CONSTRAINT "space_items_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "reminders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_items" ADD CONSTRAINT "space_items_calendarEventId_fkey" FOREIGN KEY ("calendarEventId") REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "reminders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_logs" ADD CONSTRAINT "event_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productivity_snapshots" ADD CONSTRAINT "productivity_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
