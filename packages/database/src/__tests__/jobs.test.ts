import { describe, expect, it } from 'vitest';

import { computeBackoffDelayMs, MAX_BACKOFF_MS, normalizeJobError } from '../repositories/jobs';

/**
 * The pure parts of the job store's retry policy. The database-backed
 * behaviours (claiming, transitions, dedupe, leases) are proven against real
 * PostgreSQL in the integration suite; here only the arithmetic and the error
 * normalisation are pinned down.
 */
describe('computeBackoffDelayMs', () => {
  it('waits one base interval after the first failure', () => {
    // attempts is the count after the failing claim, so the first failure is 1.
    expect(computeBackoffDelayMs(1, 10_000)).toBe(10_000);
  });

  it('doubles per subsequent attempt', () => {
    expect(computeBackoffDelayMs(2, 10_000)).toBe(20_000);
    expect(computeBackoffDelayMs(3, 10_000)).toBe(40_000);
    expect(computeBackoffDelayMs(4, 10_000)).toBe(80_000);
  });

  it('caps delays at the ceiling', () => {
    expect(computeBackoffDelayMs(10, 10_000)).toBe(MAX_BACKOFF_MS);
    expect(computeBackoffDelayMs(10, 10_000, 60_000)).toBe(60_000);
  });

  it('caps a base interval that alone exceeds the ceiling', () => {
    expect(computeBackoffDelayMs(1, 120_000, 60_000)).toBe(60_000);
  });

  it('treats zero or negative attempts as the first failure', () => {
    expect(computeBackoffDelayMs(0, 10_000)).toBe(10_000);
  });
});

describe('normalizeJobError', () => {
  it('keeps the error type and message', () => {
    expect(normalizeJobError(new Error('provider unavailable'))).toBe(
      'Error: provider unavailable',
    );
  });

  it('keeps custom error names', () => {
    class RetryableDeliveryError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'RetryableDeliveryError';
      }
    }
    expect(normalizeJobError(new RetryableDeliveryError('timeout'))).toBe(
      'RetryableDeliveryError: timeout',
    );
  });

  it('accepts plain strings', () => {
    expect(normalizeJobError('quota exceeded')).toBe('quota exceeded');
  });

  it('maps anything else to a stable placeholder', () => {
    expect(normalizeJobError(undefined)).toBe('unknown failure');
    expect(normalizeJobError(null)).toBe('unknown failure');
    expect(normalizeJobError(42)).toBe('unknown failure');
    expect(normalizeJobError('')).toBe('unknown failure');
  });

  it('bounds the stored length', () => {
    const long = 'x'.repeat(2000);
    expect(normalizeJobError(new Error(long))).toHaveLength(500);
  });
});
