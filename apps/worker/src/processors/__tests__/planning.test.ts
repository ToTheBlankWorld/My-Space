import { vi, describe, expect, it, beforeEach } from 'vitest';

import type { Database } from '@space/database';

import type { Logger } from '@space/logger';
import { createLogger } from '@space/logger';
import { FixedClock } from '@space/time';

import { processPlanningJob, type PlanningJobPayload } from '../planning';

/**
 * The shared planning processor, with the planning/engine/autonomy surfaces
 * mocked and a fake database handle. Both runtimes delegate here, so these
 * tests pin: the planVersion CAS (stale jobs no-op), validation failures
 * completing without retry, autonomous diff emission, and audit events.
 */

vi.mock('@space/planning', () => ({
  loadPlanningInput: vi.fn(),
  persistPlanningResult: vi.fn(),
  buildPlanningCompletedPayload: vi.fn().mockReturnValue({ mode: 'FULL' }),
}));

vi.mock('@space/engine', () => ({
  plan: vi.fn(),
  validatePlanningInput: vi.fn(),
}));

vi.mock('@space/autonomy', () => ({
  computePlanDiff: vi.fn().mockReturnValue({
    counts: { added: 1, removed: 0, moved: 0 },
    hasMeaningfulChange: true,
    entries: [],
  }),
}));

import { computePlanDiff } from '@space/autonomy';
import { plan, validatePlanningInput } from '@space/engine';
import { loadPlanningInput, persistPlanningResult } from '@space/planning';

const silentLogger = (): Logger =>
  createLogger({
    name: 'planning-test',
    level: 'fatal',
    destination: { write: () => undefined },
  });

const PLAN = {
  scheduledBlocks: [{ taskId: 't1' }],
  unscheduledTasks: [],
  conflicts: [],
  durationMs: 5,
  planVersion: 8,
};

const makeDeps = () => {
  const db = {
    eventLog: { create: vi.fn().mockResolvedValue({ id: 'evt' }) },
    space: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'space_1234',
        planVersion: 7,
        status: 'ACTIVE',
        timeZone: 'Europe/Lisbon',
      }),
    },
  };
  const deps = {
    db: db as unknown as Database,
    clock: new FixedClock(new Date('2026-09-13T08:00:00.000Z')),
    logger: silentLogger(),
    maxTasksPerPlan: 100,
  };
  return { deps, db };
};

const payload = (overrides: Partial<PlanningJobPayload> = {}): PlanningJobPayload => ({
  userId: 'user_1',
  date: '2026-09-13',
  spaceId: 'space_1234',
  planVersion: 7,
  trigger: 'autonomous',
  ...overrides,
});

beforeEach(() => {
  vi.mocked(loadPlanningInput).mockReset().mockResolvedValue({ existingItems: [], tasks: [] } as never);
  vi.mocked(validatePlanningInput).mockReset().mockReturnValue({ valid: true, violations: [] });
  vi.mocked(plan).mockReset().mockReturnValue(PLAN as never);
  vi.mocked(persistPlanningResult).mockReset().mockResolvedValue({ applied: true, mode: 'FULL' } as never);
});

describe('planning processor', () => {
  it('plans, persists, and audits a completed pass', async () => {
    const { deps } = makeDeps();

    const result = await processPlanningJob(deps, payload());

    expect(result).toMatchObject({
      success: true,
      outcome: { applied: true, mode: 'FULL', scheduledBlocks: 1 },
    });
    expect(plan).toHaveBeenCalledTimes(1);
    const persistArgs = vi.mocked(persistPlanningResult).mock.calls[0]?.[2] as {
      planVersion?: number;
      correlationId?: string;
    };
    expect(persistArgs?.planVersion).toBe(7);
    expect(typeof persistArgs?.correlationId).toBe('string');
  });

  it('no-ops a stale job whose planVersion moved under it', async () => {
    const { deps, db } = makeDeps();
    db.space.findFirst.mockResolvedValue({
      id: 'space_1234',
      planVersion: 9, // moved on
      status: 'ACTIVE',
      timeZone: 'Europe/Lisbon',
    });

    const result = await processPlanningJob(deps, payload({ planVersion: 7 }));

    expect(result).toEqual({ success: true, skipped: 'stale-version' });
    expect(loadPlanningInput).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(persistPlanningResult).not.toHaveBeenCalled();
  });

  it('skips when the space does not exist or is not owned', async () => {
    const { deps, db } = makeDeps();
    db.space.findFirst.mockResolvedValue(null);

    const result = await processPlanningJob(deps, payload());

    expect(result).toEqual({ success: true, skipped: 'space-not-found' });
    expect(plan).not.toHaveBeenCalled();
  });

  it('completes (without retry) when the planning input is invalid', async () => {
    const { deps, db } = makeDeps();
    vi.mocked(validatePlanningInput).mockReturnValue({
      valid: false,
      violations: [{ field: 'dueAt', message: 'in the past', severity: 'error' }],
    } as never);

    const result = await processPlanningJob(deps, payload());

    expect(result).toEqual({ success: true, failed: 'validation' });
    expect(plan).not.toHaveBeenCalled();
    // The failure was audited.
    const failedEvent = db.eventLog.create.mock.calls.at(-1)?.[0] as {
      data: { eventType?: string };
    };
    expect(failedEvent?.data.eventType).toBe('PLANNING_FAILED');
  });

  it('emits SPACE_OPTIMIZED with the plan diff for autonomous triggers', async () => {
    const { deps, db } = makeDeps();

    await processPlanningJob(deps, payload({ trigger: 'autonomous' }));

    expect(computePlanDiff).toHaveBeenCalledTimes(1);
    const optimizedEvent = db.eventLog.create.mock.calls.at(-1)?.[0] as {
      data: { eventType?: string };
    };
    expect(optimizedEvent?.data.eventType).toBe('SPACE_OPTIMIZED');
  });

  it('does not emit SPACE_OPTIMIZED for user-triggered passes', async () => {
    const { deps } = makeDeps();

    await processPlanningJob(deps, payload({ trigger: 'user' }));

    expect(computePlanDiff).not.toHaveBeenCalled();
  });

  it('audits PLANNING_FAILED and rethrows unexpected errors for the queue to retry', async () => {
    const { deps, db } = makeDeps();
    vi.mocked(persistPlanningResult).mockRejectedValue(new Error('db write failed'));

    await expect(processPlanningJob(deps, payload())).rejects.toThrow('db write failed');
    const failedEvent = db.eventLog.create.mock.calls.at(-1)?.[0] as {
      data: { eventType?: string };
    };
    expect(failedEvent?.data.eventType).toBe('PLANNING_FAILED');
  });
});
