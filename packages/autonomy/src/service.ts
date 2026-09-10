import { audit, work, type Database } from '@space/database';
import type { Logger } from '@space/logger';
import {
  addCalendarDays,
  asTimeZone,
  calendarDateRange,
  instantAtLocalTime,
  toCalendarDate,
  toDatabaseDate,
  type Clock,
} from '@space/time';
import type { CalendarDate, EventType, NotificationPriority } from '@space/types';
import {
  createDraft,
  evaluateDeadlineWarning,
  evaluateTaskMissed,
  type UserNotificationSettings,
} from '@space/notifications';

import { atLeast } from './change';
import { resolveAffectedSpaces } from './affected-spaces';
import { analyzeImpact } from './impact';
import { checkFeedbackLoop } from './feedback-loop';
import { batchTitle, createNotificationBatch, summarizeBatch } from './notification-batching';
import { evaluateAutonomy } from './policy';
import { checkPlanStaleness } from './staleness';
import { resolveTriggerNode } from './trigger-graph';
import type {
  ChangeClassification,
  ChangeReasonCode,
  NotificationBatchEntry,
  ReplanRequest,
  ReviewSummary,
} from './types';

/**
 * The autonomous space loop.
 *
 * One review pass walks OBSERVE → DETECT → CLASSIFY over today's real signals
 * (elapsed blocks, at-risk deadlines, calendar drift, an unplanned tomorrow)
 * and delegates every day that needs it to a coalesced, version-guarded replan
 * job on the planning queue. The loop never builds a plan itself: the
 * deterministic @space/engine does that, through the same persist path a click
 * would use, so an autonomous decision can never produce a schedule the
 * product's other paths would not.
 *
 * Determinism and safety:
 *  - Every phase is a bounded, ordered read followed by idempotent writes.
 *  - Replans are version-guarded: the planning worker only applies a pass whose
 *    `planVersion` still matches, so a racing edit or a replayed job is a no-op.
 *  - Notifications are idempotent by `deliveryKey` (physical unique index).
 *  - Task transitions are enforced by the transition table and fire only under
 *    AUTOMATICALLY_MANAGE.
 *  - No event storm: a space is never re-enqueued twice in one pass, and never
 *    within the coalescing window unless the change is URGENT.
 */

export interface AutonomyServiceDeps {
  db: Database;
  clock: Clock;
  logger: Logger;
  /** APP_URL — passed to the notification policy for deep links. */
  appUrl: string;
  /** Adds one replan job to the planning queue (coalesced by spaceId upstream). */
  enqueueReplan: (request: ReplanRequest) => Promise<void>;
  /** A planned space is not re-enqueued more than once per window, unless URGENT. */
  coalesceWindowMs?: number;
  /** Replans are enqueued for deadlines at or before this horizon. */
  deadlineReplanWindowMs?: number;
  maxReviewUsers?: number;
  maxEventsPerPass?: number;
}

export interface AutonomyService {
  /** Runs one full review pass and returns a bounded summary. */
  review(): Promise<ReviewSummary>;
}

export const DEFAULT_COALESCE_WINDOW_MS = 5 * 60_000;
export const DEFAULT_DEADLINE_REPLAN_WINDOW_MS = 72 * 60 * 60_000;
export const DEFAULT_MAX_REVIEW_USERS = 200;
export const DEFAULT_MAX_EVENTS_PER_PASS = 50;
/** How far back to scan for events in the trigger-graph phase (ms). */
export const TRIGGER_SCAN_WINDOW_MS = 10 * 60_000; // 10 minutes

const OPEN_STATUSES = ['INBOX', 'PLANNED', 'IN_PROGRESS', 'RESCHEDULED'] as const;

interface SettingsRow {
  notificationsEnabled: boolean;
  emailNotificationsEnabled: boolean;
  timeZone: string;
}

const toSettings = (row: SettingsRow): UserNotificationSettings => ({
  notificationsEnabled: row.notificationsEnabled,
  emailNotificationsEnabled: row.emailNotificationsEnabled,
  timeZone: asTimeZone(row.timeZone),
  morningNotificationMinute: null,
  middayNotificationMinute: null,
  eveningNotificationMinute: null,
});

interface ReplanSpace {
  userId: string;
  id: string;
  date: Date;
  planVersion: number;
  optimizedAt: Date | null;
}

const isUrgent = (change: ChangeClassification): boolean => atLeast(change, 'URGENT_REPLAN');

/** Maps a batched change's max classification to a notification priority. */
const classificationToPriority = (classification: ChangeClassification): NotificationPriority => {
  switch (classification) {
    case 'URGENT_REPLAN':
      return 'CRITICAL';
    case 'REPLAN_REQUIRED':
      return 'IMPORTANT';
    case 'REVIEW_ONLY':
      return 'NORMAL';
    default:
      return 'NORMAL';
  }
};

export const createAutonomyService = (deps: AutonomyServiceDeps): AutonomyService => {
  const {
    db,
    clock,
    logger,
    appUrl,
    enqueueReplan,
    coalesceWindowMs = DEFAULT_COALESCE_WINDOW_MS,
    deadlineReplanWindowMs = DEFAULT_DEADLINE_REPLAN_WINDOW_MS,
    maxReviewUsers = DEFAULT_MAX_REVIEW_USERS,
    maxEventsPerPass = DEFAULT_MAX_EVENTS_PER_PASS,
  } = deps;

  const baseLogger = logger.child({ service: 'autonomy' });

  // -------------------------------------------------------------------------
  // Phase 0 — trigger-graph event scan (Stage 9)
  //
  // Scans recent events from the event log, resolves their trigger nodes,
  // determines affected Spaces, and evaluates impact + autonomy policy before
  // enqueuing replans. This phase replaces the flat event-type classification
  // with a structured pipeline that avoids unnecessary replans.
  // -------------------------------------------------------------------------

  const runTriggerPhase = async (
    summary: ReviewSummary,
    now: Date,
    enqueue: ReplanSink,
  ): Promise<void> => {
    const windowStart = new Date(now.getTime() - TRIGGER_SCAN_WINDOW_MS);

    // Scan recent events. We only look at events that might require action;
    // the trigger graph filters out NO_REPLAN events.
    const events = await db.eventLog.findMany({
      where: {
        occurredAt: { gte: windowStart },
        eventType: {
          in: [
            'TASK_CREATED',
            'TASK_UPDATED',
            'TASK_COMPLETED',
            'TASK_RESCHEDULED',
            'CALENDAR_CHANGED',
            'CALENDAR_SYNCED',
          ] as EventType[],
        },
      },
      orderBy: { sequence: 'desc' },
      take: maxEventsPerPass,
    });

    if (events.length === 0) return;
    summary.triggerEventsScanned += events.length;

    const batchEntriesBySpace = new Map<string, NotificationBatchEntry[]>();

    for (const event of events) {
      const node = resolveTriggerNode(event.eventType);
      if (!node.requiresReplan) continue;

      // Resolve affected Spaces for this event.
      const affectedSpaces = await resolveAffectedSpaces({
        db,
        userId: event.userId,
        eventType: event.eventType,
        aggregateId: event.aggregateId ?? '',
        aggregateType: event.aggregateType,
        occurredAt: event.occurredAt,
        payload: (event.payload as Record<string, unknown>) ?? undefined,
      });

      for (const space of affectedSpaces) {
        // Impact analysis: does this change actually affect the current plan?
        const impact = await analyzeImpact(db, {
          db,
          space,
          eventType: event.eventType,
          reasonCode: node.reasonCode,
          entityId: event.aggregateId ?? undefined,
          payload: (event.payload as Record<string, unknown>) ?? undefined,
        });

        if (!impact.hasMaterialImpact) {
          summary.triggerImpactSkipped += 1;
          baseLogger.debug(
            { spaceId: space.spaceId, eventType: event.eventType },
            'trigger phase: no material impact, skipping replan',
          );
          continue;
        }

        // Staleness check: is the plan already stale from a newer event?
        const staleness = checkPlanStaleness(db, space, clock.now());
        if (!staleness.stale) {
          baseLogger.debug(
            { spaceId: space.spaceId, reason: staleness.reason },
            'trigger phase: plan is fresh, skipping replan',
          );
          continue;
        }

        // Autonomy policy: is the user's level sufficient?
        const autonomyDecision = await evaluateAutonomy(db, clock, {
          db,
          userId: event.userId,
          space,
          eventType: event.eventType,
        });

        if (!autonomyDecision.allowed) {
          summary.triggerAutonomyDenied += 1;
          baseLogger.info(
            { spaceId: space.spaceId, reason: autonomyDecision.reason },
            'trigger phase: autonomy policy denied replan',
          );
          continue;
        }

        // Feedback-loop check for the triggering entity.
        if (event.aggregateId) {
          const feedbackCheck = await checkFeedbackLoop(
            db,
            clock,
            event.userId,
            space.spaceId,
            event.aggregateId,
          );
          if (feedbackCheck.suppressed) {
            summary.triggerFeedbackSuppressed += 1;
            baseLogger.info(
              { spaceId: space.spaceId, taskId: event.aggregateId, reason: feedbackCheck.reason },
              'trigger phase: feedback-loop suppression active',
            );
            continue;
          }
        }

        const classification =
          impact.maxClassification !== 'NO_REPLAN'
            ? impact.maxClassification
            : node.baseClassification;

        // Enqueue through the coalescing, version-guarded sink.
        const enqueued = await enqueue(
          {
            userId: space.userId,
            id: space.spaceId,
            date: toDatabaseDate(space.date),
            planVersion: space.planVersion,
            optimizedAt: space.optimizedAt,
          },
          {
            classification,
            reasonCode: node.reasonCode,
            rationale: impact.rationale,
          },
          now,
        );

        if (!enqueued) {
          summary.replansCoalesced += 1;
          baseLogger.debug(
            { spaceId: space.spaceId, eventType: event.eventType },
            'trigger phase: replan coalesced by sink',
          );
          continue;
        }

        summary.triggerReplansQueued += 1;
        summary.replansEnqueued += 1;

        // Accumulate notification batch entries only for spaces that actually
        // got a replan enqueued.
        const batchKey = `${space.userId}:${space.spaceId}:${space.date}`;
        const existingEntries = batchEntriesBySpace.get(batchKey) ?? [];
        existingEntries.push({
          reasonCode: node.reasonCode,
          message: impact.rationale,
          classification,
        });
        batchEntriesBySpace.set(batchKey, existingEntries);

        baseLogger.info(
          {
            spaceId: space.spaceId,
            eventType: event.eventType,
            classification,
            signals: impact.signals.length,
          },
          'trigger phase: replan queued via trigger graph',
        );
      }
    }

    // Flush one in-app digest per affected Space. Email legs for plan changes
    // are emitted by the completion path once the new plan applies, so the
    // batch digest is in-app only (email: null keeps it honest).
    if (batchEntriesBySpace.size > 0) {
      const userIds = [
        ...new Set([...batchEntriesBySpace.keys()].map((key) => key.split(':')[0]!)),
      ];
      const settingsRows = await db.userPreferences.findMany({
        where: { userId: { in: userIds } },
      });
      const settingsById = new Map(settingsRows.map((row) => [row.userId, row]));

      for (const [batchKey, entries] of batchEntriesBySpace) {
        const [userId, spaceId, date] = batchKey.split(':');
        const settingsRow: SettingsRow | undefined = settingsById.get(userId!);
        if (!settingsRow || !settingsRow.notificationsEnabled) {
          continue;
        }

        const batch = createNotificationBatch(
          entries,
          userId!,
          spaceId!,
          date as CalendarDate,
          now,
        );
        const created = await createDraft(
          { db },
          {
            type: 'SCHEDULE_CHANGE',
            priority: classificationToPriority(batch.maxPriority),
            title: batchTitle(batch),
            body: summarizeBatch(batch),
            scheduledAt: null,
            deliveryKey: `plan-batch:${userId}:${spaceId}:${date}:${batch.maxPriority}`,
            linkUrl: `${appUrl}/space/${date}`,
          },
          { userId: userId!, occurredAt: now, email: null },
        );
        summary.notificationsBatched += created;
      }
    }
  };

  // -------------------------------------------------------------------------
  // Phase 1 — elapsed blocks that were never completed (missed tasks)
  // -------------------------------------------------------------------------

  const runMissedPhase = async (summary: ReviewSummary, now: Date): Promise<void> => {
    const rows = await db.task.findMany({
      where: {
        status: 'PLANNED',
        scheduledStart: { not: null },
        scheduledEnd: { not: null, lt: now },
      },
      select: {
        id: true,
        title: true,
        userId: true,
        spaceId: true,
        scheduledStart: true,
        scheduledEnd: true,
      },
      orderBy: [{ scheduledEnd: 'asc' }, { id: 'asc' }],
      take: maxReviewUsers,
    });
    if (rows.length === 0) {
      return;
    }

    const userIds = [...new Set(rows.map((row) => row.userId))];
    const [autonomyRows, settingsRows, emails] = await Promise.all([
      db.planningPreferences.findMany({ where: { userId: { in: userIds } } }),
      db.userPreferences.findMany({ where: { userId: { in: userIds } } }),
      db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }),
    ]);
    const autonomyById = new Map(autonomyRows.map((row) => [row.userId, row.autonomyLevel]));
    const settingsById = new Map(settingsRows.map((row) => [row.userId, row]));
    const emailById = new Map(emails.map((row) => [row.id, row.email]));

    for (const row of rows) {
      if (row.scheduledStart === null || row.scheduledEnd === null) {
        continue;
      }
      const settingsRow: SettingsRow | undefined = settingsById.get(row.userId);
      if (!settingsRow) {
        continue;
      }
      const timeZone = asTimeZone(settingsRow.timeZone);
      const missedDate = toCalendarDate(row.scheduledStart, timeZone);

      summary.missedDetected += 1;

      const autonomy = autonomyById.get(row.userId) ?? 'ASK_BEFORE_CHANGING';
      if (autonomy === 'AUTOMATICALLY_MANAGE') {
        try {
          const outcome = await work.transitionTaskStatus(db, row.userId, row.id, 'MISSED', now, {
            trigger: 'autonomous',
            reason: 'missed:elapsed-scheduled-block',
            spaceId: row.spaceId ?? undefined,
          });
          if (outcome.changed) {
            summary.missedTransitioned += 1;
          }
        } catch {
          // A concurrent edit already moved the task; the notification below
          // still tells the truth about the elapsed block.
        }
      }

      if (settingsRow.notificationsEnabled) {
        const settings = toSettings(settingsRow);
        const draft = evaluateTaskMissed(
          settings,
          { taskId: row.id, title: row.title, missedDate },
          appUrl,
        );
        const created = await createDraft({ db }, draft, {
          userId: row.userId,
          occurredAt: now,
          email: settings.emailNotificationsEnabled ? (emailById.get(row.userId) ?? null) : null,
        });
        summary.missedNotified += created;
      }

      baseLogger.info({ taskId: row.id, missedDate }, 'autonomy: missed task handled');
    }
  };

  // -------------------------------------------------------------------------
  // Phase 2 — open tasks whose deadline is at risk or unmeetable
  // -------------------------------------------------------------------------

  const runDeadlinePhase = async (
    summary: ReviewSummary,
    now: Date,
    enqueue: ReplanSink,
  ): Promise<void> => {
    const rows = await db.task.findMany({
      where: {
        status: { in: [...OPEN_STATUSES] },
        dueAt: {
          not: null,
          gte: new Date(now.getTime() - 60_000),
          lte: new Date(now.getTime() + deadlineReplanWindowMs),
        },
      },
      select: {
        id: true,
        title: true,
        userId: true,
        spaceId: true,
        dueAt: true,
        scheduledEnd: true,
      },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: maxReviewUsers,
    });
    if (rows.length === 0) {
      return;
    }

    const userIds = [...new Set(rows.map((row) => row.userId))];
    const [settingsRows, emails] = await Promise.all([
      db.userPreferences.findMany({ where: { userId: { in: userIds } } }),
      db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }),
    ]);
    const settingsById = new Map(settingsRows.map((row) => [row.userId, row]));
    const emailById = new Map(emails.map((row) => [row.id, row.email]));

    const spaceCache = new Map<string, Promise<ReplanSpace | null>>();
    const findSpace = (userId: string, spaceId: string | null): Promise<ReplanSpace | null> => {
      if (spaceId === null) {
        return Promise.resolve(null);
      }
      const cached = spaceCache.get(spaceId);
      if (cached) {
        return cached;
      }
      const promise = db.space
        .findFirst({
          where: { id: spaceId, userId },
          select: { id: true, userId: true, date: true, planVersion: true, optimizedAt: true },
        })
        .then((space) =>
          space
            ? {
                id: space.id,
                userId: space.userId,
                date: space.date,
                planVersion: space.planVersion,
                optimizedAt: space.optimizedAt,
              }
            : null,
        );
      spaceCache.set(spaceId, promise);
      return promise;
    };

    for (const row of rows) {
      if (row.dueAt === null) {
        continue;
      }
      const dueAt = row.dueAt;
      const settingsRow: SettingsRow | undefined = settingsById.get(row.userId);
      const timeZone = asTimeZone(settingsRow?.timeZone ?? 'UTC');
      const dueDate = toCalendarDate(dueAt, timeZone);
      const today = toCalendarDate(now, timeZone);
      const dueToday = dueDate === today;
      const overdue = dueAt.getTime() < now.getTime();
      const deadlineMet =
        row.scheduledEnd !== null && row.scheduledEnd.getTime() <= dueAt.getTime();

      summary.deadlineCases += 1;

      if (deadlineMet) {
        continue;
      }

      // Stage 7 policy: one impression per task per due date, due today only.
      if (settingsRow && dueToday && settingsRow.notificationsEnabled) {
        const settings = toSettings(settingsRow);
        const draft = evaluateDeadlineWarning(
          settings,
          { taskId: row.id, title: row.title, dueAt, taskPriority: 'NORMAL' },
          timeZone,
          appUrl,
        );
        const created = await createDraft({ db }, draft, {
          userId: row.userId,
          occurredAt: now,
          email: settings.emailNotificationsEnabled ? (emailById.get(row.userId) ?? null) : null,
        });
        summary.deadlineNotified += created;
      }

      // Audit: one DEADLINE_APPROACHING event per task per dueAt.
      const previous = await db.eventLog.findFirst({
        where: { eventType: 'DEADLINE_APPROACHING', aggregateType: 'TASK', aggregateId: row.id },
        orderBy: { sequence: 'desc' },
      });
      const previousDueAt = (previous?.payload as { dueAt?: string } | null)?.dueAt;
      if (previousDueAt !== dueAt.toISOString()) {
        await audit.appendEvent(db, row.userId, {
          eventType: 'DEADLINE_APPROACHING',
          aggregateType: 'TASK',
          aggregateId: row.id,
          payload: { dueAt: dueAt.toISOString(), dueDate, overdue, deadlineMet },
          occurredAt: now,
        });
        summary.deadlineEvents += 1;
      }

      const space = await findSpace(row.userId, row.spaceId);
      if (space === null) {
        continue;
      }

      const urgent = dueToday || overdue;
      const changed: ChangeClassification = urgent ? 'URGENT_REPLAN' : 'REPLAN_REQUIRED';
      const reasonCode: ChangeReasonCode = overdue
        ? 'TASK_OVERDUE'
        : dueToday
          ? 'DEADLINE_IMPOSSIBLE'
          : 'DEADLINE_IMPENDING';
      const enqueued = await enqueue(
        space,
        {
          classification: changed,
          reasonCode,
          rationale: `Task ${row.id} is due ${dueDate} and is not placed to meet its deadline.`,
        },
        now,
      );
      if (enqueued) {
        summary.replansEnqueued += 1;
      } else {
        summary.replansCoalesced += 1;
      }
    }
  };

  // -------------------------------------------------------------------------
  // Phase 3 — calendar drift since the last review
  // -------------------------------------------------------------------------

  const runCalendarPhase = async (
    summary: ReviewSummary,
    now: Date,
    enqueue: ReplanSink,
  ): Promise<void> => {
    const windowStart = new Date(now.getTime() - coalesceWindowMs * 2 - 60_000);
    const events = await db.eventLog.findMany({
      where: { eventType: 'CALENDAR_CHANGED', occurredAt: { gte: windowStart } },
      orderBy: { sequence: 'desc' },
      take: maxEventsPerPass,
    });
    if (events.length === 0) {
      return;
    }

    const horizonStart = new Date(now.getTime() - deadlineReplanWindowMs);
    const horizonEnd = new Date(now.getTime() + deadlineReplanWindowMs);
    const seenCalendars = new Set<string>();

    for (const event of events) {
      const payload = (event.payload ?? {}) as { calendarId?: string };
      const calendarId = payload.calendarId;
      if (!calendarId || seenCalendars.has(calendarId)) {
        continue;
      }
      seenCalendars.add(calendarId);
      summary.calendarChanges += 1;

      const changedEvents = await db.calendarEvent.findMany({
        where: {
          userId: event.userId,
          calendarId,
          deletedAt: null,
          startAt: { lt: horizonEnd },
          endAt: { gt: horizonStart },
        },
        select: { startAt: true, timeZone: true },
      });
      if (changedEvents.length === 0) {
        continue;
      }

      const zone = asTimeZone(changedEvents[0]?.timeZone ?? 'UTC');
      const dates = [...new Set(changedEvents.map((item) => toCalendarDate(item.startAt, zone)))];
      if (dates.length === 0) {
        continue;
      }

      const dateValues = dates.map((date) => toDatabaseDate(date));
      const plannedSpaces = await db.space.findMany({
        where: { userId: event.userId, date: { in: dateValues }, planVersion: { gt: 0 } },
        select: { id: true, userId: true, date: true, planVersion: true, optimizedAt: true },
      });

      for (const space of plannedSpaces) {
        const enqueued = await enqueue(
          space,
          {
            classification: 'REPLAN_REQUIRED',
            reasonCode: 'CALENDAR_CHANGED',
            rationale: 'Calendar events on the day changed at the last sync.',
          },
          now,
        );
        if (enqueued) {
          summary.calendarReplans += 1;
        } else {
          summary.replansCoalesced += 1;
        }
      }
    }
  };

  // -------------------------------------------------------------------------
  // Phase 4 — an unplanned tomorrow, when the user's schedule says "go"
  // -------------------------------------------------------------------------

  const runTomorrowPhase = async (
    summary: ReviewSummary,
    now: Date,
    enqueue: ReplanSink,
  ): Promise<void> => {
    const rows = await db.planningPreferences.findMany({
      where: { autonomyLevel: 'AUTOMATICALLY_MANAGE', preferredPlanningMinute: { not: null } },
      take: maxReviewUsers,
    });
    if (rows.length === 0) {
      return;
    }

    const userIds = rows.map((row) => row.userId);
    const prefsRows = await db.userPreferences.findMany({
      where: { userId: { in: userIds } },
    });
    const tzById = new Map(prefsRows.map((row) => [row.userId, asTimeZone(row.timeZone)]));

    for (const row of rows) {
      const zone = tzById.get(row.userId) ?? asTimeZone('UTC');
      const today = toCalendarDate(now, zone);
      const tomorrow = addCalendarDays(today, 1);

      const minute = row.preferredPlanningMinute;
      if (minute === null) {
        continue;
      }
      const cutoff = instantAtLocalTime(tomorrow, minute, zone);
      if (now.getTime() < cutoff.getTime()) {
        continue;
      }

      const space = await db.space.findFirst({
        where: { userId: row.userId, date: toDatabaseDate(tomorrow), plannedAt: null },
        select: { id: true, userId: true, date: true, planVersion: true, optimizedAt: true },
      });
      if (space === null) {
        continue;
      }

      const { start, end } = calendarDateRange(tomorrow, zone);
      const openCount = await db.task.count({
        where: {
          userId: row.userId,
          status: { in: [...OPEN_STATUSES] },
          OR: [
            { spaceId: space.id },
            { dueAt: { gte: start, lt: end } },
            { scheduledStart: { gte: start, lt: end } },
          ],
        },
      });
      if (openCount === 0) {
        continue;
      }

      const enqueued = await enqueue(
        space,
        {
          classification: 'REPLAN_REQUIRED',
          reasonCode: 'TOMORROW_UNPLANNED',
          rationale: `Tomorrow (${tomorrow}) is not planned yet and has open work.`,
        },
        now,
      );
      if (enqueued) {
        summary.tomorrowPlans += 1;
      } else {
        summary.replansCoalesced += 1;
      }
    }
  };

  // -------------------------------------------------------------------------
  // Composition
  // -------------------------------------------------------------------------

  type ReplanSink = (space: ReplanSpace, change: ReplanChange, now: Date) => Promise<boolean>;

  interface ReplanChange {
    classification: ChangeClassification;
    reasonCode: ChangeReasonCode;
    rationale: string;
  }

  /** Applies the coalescing window + per-pass dedup, then forwards upstream. */
  const makeSink = (): ReplanSink => {
    const seenThisPass = new Set<string>();
    return async (space, change, reviewNow) => {
      const key = space.id;
      if (seenThisPass.has(key)) {
        return false;
      }
      if (
        !isUrgent(change.classification) &&
        space.optimizedAt !== null &&
        reviewNow.getTime() - space.optimizedAt.getTime() < coalesceWindowMs
      ) {
        return false;
      }
      seenThisPass.add(key);
      await enqueueReplan({
        userId: space.userId,
        spaceId: space.id,
        date: toCalendarDate(space.date, 'UTC'),
        planVersion: space.planVersion,
        classification: change.classification,
        reasonCode: change.reasonCode,
        rationale: change.rationale,
      });
      return true;
    };
  };

  const review = async (): Promise<ReviewSummary> => {
    const now = clock.now();
    const summary: ReviewSummary = {
      reviewedAt: now,
      missedDetected: 0,
      missedTransitioned: 0,
      missedNotified: 0,
      deadlineCases: 0,
      deadlineEvents: 0,
      deadlineNotified: 0,
      calendarChanges: 0,
      calendarReplans: 0,
      tomorrowPlans: 0,
      replansEnqueued: 0,
      replansCoalesced: 0,
      triggerEventsScanned: 0,
      triggerReplansQueued: 0,
      triggerImpactSkipped: 0,
      triggerFeedbackSuppressed: 0,
      triggerAutonomyDenied: 0,
      notificationsBatched: 0,
    };
    const enqueue = makeSink();

    // Phase 0: trigger-graph event scan (Stage 9).
    await runTriggerPhase(summary, now, enqueue);
    // Phase 1-4: existing review phases.
    await runMissedPhase(summary, now);
    await runDeadlinePhase(summary, now, enqueue);
    await runCalendarPhase(summary, now, enqueue);
    await runTomorrowPhase(summary, now, enqueue);

    baseLogger.info(
      {
        missedDetected: summary.missedDetected,
        missedTransitioned: summary.missedTransitioned,
        deadlineCases: summary.deadlineCases,
        calendarChanges: summary.calendarChanges,
        tomorrowPlans: summary.tomorrowPlans,
        replansEnqueued: summary.replansEnqueued,
        replansCoalesced: summary.replansCoalesced,
        triggerEventsScanned: summary.triggerEventsScanned,
        triggerReplansQueued: summary.triggerReplansQueued,
        triggerImpactSkipped: summary.triggerImpactSkipped,
        triggerFeedbackSuppressed: summary.triggerFeedbackSuppressed,
        triggerAutonomyDenied: summary.triggerAutonomyDenied,
        notificationsBatched: summary.notificationsBatched,
      },
      'autonomy: review finished',
    );

    return summary;
  };

  return { review };
};

export type { CalendarDate }; // re-exported for worker convenience
