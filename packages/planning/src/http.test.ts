import { describe, expect, it } from 'vitest';

import {
  PlanFailedError,
  PlanInputInvalidError,
  PlanInvalidDateError,
  PlanSpaceNotFoundError,
  PlanVersionConflictError,
} from './errors';
import { planErrorHttpStatus } from './http';

describe('planErrorHttpStatus', () => {
  it('maps each plan error code to its HTTP status', () => {
    expect(planErrorHttpStatus(new PlanInvalidDateError('2026-13-40'))).toBe(400);
    expect(planErrorHttpStatus(new PlanSpaceNotFoundError())).toBe(404);
    expect(planErrorHttpStatus(new PlanVersionConflictError())).toBe(409);
    expect(planErrorHttpStatus(new PlanInputInvalidError(['workingHours: out of range']))).toBe(
      422,
    );
    expect(planErrorHttpStatus(new PlanFailedError('nope'))).toBe(500);
  });

  it('maps unknown errors to an internal server error', () => {
    expect(planErrorHttpStatus(new Error('unexpected'))).toBe(500);
    expect(planErrorHttpStatus('string error')).toBe(500);
    expect(planErrorHttpStatus(null)).toBe(500);
  });
});
