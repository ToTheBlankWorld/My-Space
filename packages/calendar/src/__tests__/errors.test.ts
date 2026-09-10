import { describe, expect, it } from 'vitest';

import {
  CalendarAuthError,
  CalendarError,
  CalendarPermissionError,
  CalendarRateLimitError,
  CalendarSyncTokenExpiredError,
  CalendarTransientError,
  CalendarValidationError,
} from '../errors';

describe('CalendarError hierarchy', () => {
  it('all calendar errors extend CalendarError', () => {
    expect(new CalendarAuthError('auth')).toBeInstanceOf(CalendarError);
    expect(new CalendarPermissionError('perm')).toBeInstanceOf(CalendarError);
    expect(new CalendarRateLimitError('rate')).toBeInstanceOf(CalendarError);
    expect(new CalendarTransientError('transient')).toBeInstanceOf(CalendarError);
    expect(new CalendarSyncTokenExpiredError('expired')).toBeInstanceOf(CalendarError);
    expect(new CalendarValidationError('validation')).toBeInstanceOf(CalendarError);
  });

  it('all calendar errors extend Error', () => {
    expect(new CalendarAuthError('auth')).toBeInstanceOf(Error);
    expect(new CalendarTransientError('transient')).toBeInstanceOf(Error);
  });

  it('each error has the correct name', () => {
    expect(new CalendarAuthError('auth').name).toBe('CalendarAuthError');
    expect(new CalendarPermissionError('perm').name).toBe('CalendarPermissionError');
    expect(new CalendarRateLimitError('rate').name).toBe('CalendarRateLimitError');
    expect(new CalendarTransientError('transient').name).toBe('CalendarTransientError');
    expect(new CalendarSyncTokenExpiredError('expired').name).toBe('CalendarSyncTokenExpiredError');
    expect(new CalendarValidationError('validation').name).toBe('CalendarValidationError');
  });

  it('CalendarRateLimitError stores retryAfterMs', () => {
    const error = new CalendarRateLimitError('rate limited', { retryAfterMs: 30_000 });
    expect(error.retryAfterMs).toBe(30_000);
  });

  it('CalendarRateLimitError defaults retryAfterMs to undefined', () => {
    const error = new CalendarRateLimitError('rate limited');
    expect(error.retryAfterMs).toBeUndefined();
  });

  it('errors preserve the cause', () => {
    const cause = new Error('root cause');
    const error = new CalendarAuthError('auth failed', { cause });
    expect(error.cause).toBe(cause);
  });
});
