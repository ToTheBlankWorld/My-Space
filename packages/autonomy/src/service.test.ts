import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Database } from '@space/database';
import type { Logger } from '@space/logger';
import type { Clock } from '@space/time';
import type { IsoDateTime } from '@space/types';

import { createAutonomyService } from './service';

import type { ReplanRequest } from './types';

const NOW = new Date('2025-06-15T12:00:00Z');

const mockTask = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-test-001',
  title: 'Test task',
  userId: 'user-test-001',
  spaceId: 'space-test-001',
  scheduledStart: new Date('2025-06-15T09:00:00Z'),
  scheduledEnd: new Date('2025-06-15T10:00:00Z'),
  dueAt: null,
  status: 'PLANNED',
  ...overrides,
});

const mockSpace = (overrides: Record<string, unknown> = {}) => ({
  id: 'space-test-001',
  userId: 'user-test-001',
  date: new Date('2025-06-15T00:00:00Z'),
  planVersion: 1,
  optimizedAt: null,
  ...overrides,
});

const mockPlanningPrefs = (overrides: Record<string, unknown> = {}) => ({
  userId: 'user-test-001',
  autonomyLevel: 'AUTOMATICALLY_MANAGE',
  preferredPlanningMinute: 480,
  timeZone: 'UTC',
  ...overrides,
});

const mockUserPrefs = (overrides: Record<string, unknown> = {}) => ({
  userId: 'user-test-001',
  notificationsEnabled: true,
  emailNotificationsEnabled: false,
  timeZone: 'UTC',
  morningNotificationMinute: 480,
  middayNotificationMinute: 720,
  eveningNotificationMinute: 1080,
  ...overrides,
});

const mockUser = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-test-001',
  email: 'test@example.com',
  ...overrides,
});

const createMockDb = (overrides: Record<string, unknown> = {}): Database => {
  const findMany = vi.fn().mockResolvedValue([]);
  const findFirst = vi.fn().mockResolvedValue(null);
  const count = vi.fn().mockResolvedValue(0);
  const create = vi.fn().mockResolvedValue({ id: 'created-1' });

  return {
    task: { findMany, findFirst, count, create },
    space: { findMany, findFirst },
    planningPreferences: { findMany },
    userPreferences: { findMany },
    user: { findMany, findFirst },
    eventLog: { findMany, findFirst, create },
    calendarEvent: { findMany },
    notification: { create, updateMany: vi.fn() },
    emailLog: { create },
    $transaction: vi.fn(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
      fn({
        notification: { create },
        emailLog: { create },
        eventLog: { create },
      }),
    ),
    ...overrides,
  } as unknown as Database;
};

describe('createAutonomyService', () => {
  let mockEnqueue: (request: ReplanRequest) => Promise<void>;
  let mockLogger: Logger;
  let mockClock: Clock;

  beforeEach(() => {
    mockEnqueue = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
    mockLogger = {
      child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    } as unknown as Logger;
    mockClock = {
      now: () => NOW,
      nowMs: () => NOW.getTime(),
      nowIso: () => NOW.toISOString() as IsoDateTime,
    };
  });

  it('creates a service with review method', () => {
    const db = createMockDb();
    const service = createAutonomyService({
      db,
      clock: mockClock,
      logger: mockLogger,
      appUrl: 'http://localhost:3000',
      enqueueReplan: mockEnqueue,
    });

    expect(typeof service.review).toBe('function');
  });

  it('returns empty summary when no work detected', async () => {
    const db = createMockDb();
    const service = createAutonomyService({
      db,
      clock: mockClock,
      logger: mockLogger,
      appUrl: 'http://localhost:3000',
      enqueueReplan: mockEnqueue,
    });

    const summary = await service.review();
    expect(summary.missedDetected).toBe(0);
    expect(summary.deadlineCases).toBe(0);
    expect(summary.calendarChanges).toBe(0);
    expect(summary.tomorrowPlans).toBe(0);
    expect(summary.replansEnqueued).toBe(0);
    expect(summary.replansCoalesced).toBe(0);
  });

  it('detects missed tasks and transitions under AUTOMATICALLY_MANAGE', async () => {
    const missedTask = mockTask({
      id: 'task-missed-001',
      scheduledEnd: new Date('2025-06-15T10:00:00Z'), // before NOW
    });

    const db = createMockDb({
      task: {
        findMany: vi.fn().mockResolvedValue([missedTask]),
        findFirst: vi.fn().mockResolvedValue(missedTask),
        count: vi.fn().mockResolvedValue(0),
      },
      planningPreferences: {
        findMany: vi.fn().mockResolvedValue([mockPlanningPrefs()]),
      },
      userPreferences: {
        findMany: vi.fn().mockResolvedValue([mockUserPrefs()]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([mockUser()]),
        findFirst: vi.fn().mockResolvedValue(mockUser()),
      },
      $transaction: vi.fn(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
        fn({
          task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
          eventLog: { create: vi.fn().mockResolvedValue({ id: 'ev-notif-001' }) },
          agentAction: { create: vi.fn().mockResolvedValue({ id: 'aa-action-001' }) },
          notification: { create: vi.fn().mockResolvedValue({ id: 'notif-test-001' }) },
          emailLog: { create: vi.fn().mockResolvedValue({ id: 'elog-test-001' }) },
        }),
      ),
    });

    const service = createAutonomyService({
      db,
      clock: mockClock,
      logger: mockLogger,
      appUrl: 'http://localhost:3000',
      enqueueReplan: mockEnqueue,
    });

    const summary = await service.review();
    expect(summary.missedDetected).toBe(1);
    expect(summary.missedNotified).toBeGreaterThanOrEqual(1);
  });

  it('coalesces replans for the same space within a single pass', async () => {
    // Two deadline tasks in the same space should only enqueue once.
    const task1 = mockTask({
      id: 'task-deadline-001',
      dueAt: new Date('2025-06-16T12:00:00Z'),
      scheduledEnd: null,
      status: 'PLANNED',
    });
    const task2 = mockTask({
      id: 'task-deadline-002',
      dueAt: new Date('2025-06-17T12:00:00Z'),
      scheduledEnd: null,
      status: 'PLANNED',
    });

    const db = createMockDb({
      task: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([]) // missed phase
          .mockResolvedValueOnce([task1, task2]), // deadline phase
        findFirst: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(0),
      },
      space: {
        findFirst: vi.fn().mockResolvedValue(mockSpace()),
        findMany: vi.fn().mockResolvedValue([]),
      },
      planningPreferences: { findMany: vi.fn().mockResolvedValue([]) },
      userPreferences: {
        findMany: vi.fn().mockResolvedValue([mockUserPrefs()]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([mockUser()]),
        findFirst: vi.fn().mockResolvedValue(mockUser()),
      },
      eventLog: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'ev-1' }),
      },
      calendarEvent: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
        fn({
          notification: { create: vi.fn().mockResolvedValue({ id: 'notif-test-001' }) },
          emailLog: { create: vi.fn().mockResolvedValue({ id: 'elog-test-001' }) },
          eventLog: { create: vi.fn().mockResolvedValue({ id: 'ev-notif-001' }) },
        }),
      ),
    });

    const service = createAutonomyService({
      db,
      clock: mockClock,
      logger: mockLogger,
      appUrl: 'http://localhost:3000',
      enqueueReplan: mockEnqueue,
    });

    const summary = await service.review();
    // Both tasks detected, but only one replan enqueued for the same space.
    expect(summary.deadlineCases).toBe(2);
    expect(summary.replansEnqueued).toBeLessThanOrEqual(1);
    expect(summary.replansCoalesced).toBeGreaterThanOrEqual(1);
  });

  it('does not enqueue when space was recently optimized and change is not urgent', async () => {
    const task = mockTask({
      id: 'task-recent-001',
      dueAt: new Date('2025-06-17T12:00:00Z'), // not urgent (not today)
      scheduledEnd: null,
      status: 'PLANNED',
    });

    const recentSpace = mockSpace({
      optimizedAt: new Date(NOW.getTime() - 60_000), // 1 minute ago, within 5-min window
    });

    const db = createMockDb({
      task: {
        findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([task]),
        findFirst: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(0),
      },
      space: {
        findFirst: vi.fn().mockResolvedValue(recentSpace),
        findMany: vi.fn().mockResolvedValue([]),
      },
      planningPreferences: { findMany: vi.fn().mockResolvedValue([]) },
      userPreferences: {
        findMany: vi.fn().mockResolvedValue([mockUserPrefs()]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([mockUser()]),
        findFirst: vi.fn().mockResolvedValue(mockUser()),
      },
      eventLog: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'ev-1' }),
      },
      calendarEvent: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
        fn({
          notification: { create: vi.fn().mockResolvedValue({ id: 'notif-test-002' }) },
          emailLog: { create: vi.fn().mockResolvedValue({ id: 'elog-test-002' }) },
          eventLog: { create: vi.fn().mockResolvedValue({ id: 'ev-notif-002' }) },
        }),
      ),
    });

    const service = createAutonomyService({
      db,
      clock: mockClock,
      logger: mockLogger,
      appUrl: 'http://localhost:3000',
      enqueueReplan: mockEnqueue,
    });

    const summary = await service.review();
    expect(summary.deadlineCases).toBe(1);
    // Not urgent + recent optimization = coalesced/blocked
    expect(summary.replansCoalesced).toBeGreaterThanOrEqual(1);
  });

  it('trigger phase: scans events and enqueues a replan through the sink', async () => {
    // A TASK_COMPLETED event resolves to a Space with a stale plan; the rest of
    // the review finds nothing, so exactly one replan is enqueued and one
    // batched notification is created.
    const completedEvent = {
      id: 'ev-trigger-001',
      userId: 'user-test-001',
      eventType: 'TASK_COMPLETED',
      aggregateId: 'task-test-001',
      aggregateType: 'TASK',
      occurredAt: new Date(NOW.getTime() - 5 * 60_000),
      payload: { trigger: 'autonomous' },
    };

    const task = mockTask({ id: 'task-test-001' });
    const space = mockSpace({ timeZone: 'UTC' });

    const db = createMockDb({
      eventLog: {
        // First call is the trigger-graph scan; later phases see nothing.
        findMany: vi.fn().mockResolvedValueOnce([completedEvent]).mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'ev-created-001' }),
      },
      task: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(task),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({ id: 'task-created-001' }),
      },
      space: {
        findFirst: vi.fn().mockResolvedValue(space),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      planningPreferences: {
        findMany: vi.fn().mockResolvedValue([mockPlanningPrefs()]),
        findUnique: vi.fn().mockResolvedValue(mockPlanningPrefs()),
      },
      userPreferences: {
        findMany: vi.fn().mockResolvedValue([mockUserPrefs()]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([mockUser()]),
        findFirst: vi.fn().mockResolvedValue(mockUser()),
      },
      $transaction: vi.fn(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
        fn({
          notification: { create: vi.fn().mockResolvedValue({ id: 'notif-trigger-001' }) },
          emailLog: { create: vi.fn().mockResolvedValue({ id: 'elog-trigger-001' }) },
          eventLog: { create: vi.fn().mockResolvedValue({ id: 'ev-notif-trigger-001' }) },
        }),
      ),
    });

    const service = createAutonomyService({
      db,
      clock: mockClock,
      logger: mockLogger,
      appUrl: 'http://localhost:3000',
      enqueueReplan: mockEnqueue,
    });

    const summary = await service.review();
    expect(summary.triggerEventsScanned).toBe(1);
    expect(summary.triggerReplansQueued).toBe(1);
    expect(summary.replansEnqueued).toBe(1);
    expect(summary.triggerImpactSkipped).toBe(0);
    expect(summary.triggerAutonomyDenied).toBe(0);
    expect(summary.triggerFeedbackSuppressed).toBe(0);
    expect(summary.notificationsBatched).toBe(1);

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-test-001',
        spaceId: 'space-test-001',
        planVersion: 1,
        classification: 'REPLAN_REQUIRED',
        reasonCode: 'TASK_COMPLETED',
      }),
    );
  });
});
