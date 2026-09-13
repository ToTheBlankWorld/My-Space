import { vi, describe, expect, it, beforeEach } from 'vitest';

import type { Logger } from '@space/logger';
import { createLogger } from '@space/logger';
import { FixedClock } from '@space/time';

import { processAutonomyReviewJob } from '../autonomy';

/**
 * The autonomy review processor, with the service factory mocked. The review
 * itself is `@space/autonomy`'s (tested there); here we pin the delegation:
 * the service receives the clock/db/logger and the runtime-specific replan
 * sink, and its summary is returned.
 */

vi.mock('@space/autonomy', () => ({
  createAutonomyService: vi.fn(),
}));

import { createAutonomyService } from '@space/autonomy';

const silentLogger = (): Logger =>
  createLogger({
    name: 'autonomy-test',
    level: 'fatal',
    destination: { write: () => undefined },
  });

beforeEach(() => {
  vi.mocked(createAutonomyService).mockReset();
});

describe('autonomy review processor', () => {
  it('builds the service with the injected deps and returns the review summary', async () => {
    const review = vi.fn().mockResolvedValue({
      usersReviewed: 2,
      replansEnqueued: 1,
      notificationsCreated: 3,
    });
    vi.mocked(createAutonomyService).mockReturnValue({ review });

    const enqueueReplan = vi.fn().mockResolvedValue(undefined);
    const db = {} as never;
    const clock = new FixedClock(new Date('2026-09-13T10:00:00.000Z'));

    const summary = await processAutonomyReviewJob({
      db,
      clock,
      logger: silentLogger(),
      appUrl: 'https://space.test',
      enqueueReplan,
      maxReviewUsers: 50,
    });

    expect(summary).toEqual({ usersReviewed: 2, replansEnqueued: 1, notificationsCreated: 3 });
    expect(createAutonomyService).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        clock,
        appUrl: 'https://space.test',
        enqueueReplan,
        maxReviewUsers: 50,
      }),
    );
    expect(review).toHaveBeenCalledTimes(1);
  });
});
