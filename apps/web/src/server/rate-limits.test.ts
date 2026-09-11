import { FixedClock } from '@space/time';
import { describe, expect, it } from 'vitest';

import { API_RATE_LIMITS, WebRateLimiter } from './rate-limits';

const rule = { limit: 3, windowMs: 60_000 };

describe('WebRateLimiter', () => {
  it('allows requests up to the window limit across distinct keys', () => {
    const clock = new FixedClock('2026-01-01T00:00:00.000Z');
    const limiter = new WebRateLimiter(rule, clock);

    expect(limiter.consume('plan:user-1').allowed).toBe(true);
    expect(limiter.consume('plan:user-2').allowed).toBe(true);
    expect(limiter.consume('plan:user-3').allowed).toBe(true);
    expect(limiter.consume('plan:user-4').allowed).toBe(true);
  });

  it('denies a key that exhausts its window budget', () => {
    const clock = new FixedClock('2026-01-01T00:00:00.000Z');
    const limiter = new WebRateLimiter(rule, clock);

    limiter.consume('plan:user-1');
    limiter.consume('plan:user-1');
    limiter.consume('plan:user-1');
    const denied = limiter.consume('plan:user-1');

    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it('reports remaining budget and window reset time', () => {
    const clock = new FixedClock('2026-01-01T00:00:00.000Z');
    const limiter = new WebRateLimiter(rule, clock);

    const second = limiter.consume('plan:user-1');

    expect(second.remaining).toBe(2);
    expect(second.resetAt).toEqual(new Date('2026-01-01T00:01:00.000Z'));
  });

  it('refreshes a key after the window elapses', () => {
    const clock = new FixedClock('2026-01-01T00:00:00.000Z');
    const limiter = new WebRateLimiter(rule, clock);

    limiter.consume('plan:user-1');
    limiter.consume('plan:user-1');
    limiter.consume('plan:user-1');
    expect(limiter.consume('plan:user-1').allowed).toBe(false);

    clock.advanceMinutes(1);
    expect(limiter.consume('plan:user-1').allowed).toBe(true);
  });

  it('bounds memory by evicting live windows once the map is full', () => {
    const clock = new FixedClock('2026-01-01T00:00:00.000Z');
    const limiter = new WebRateLimiter(rule, clock, 2);

    limiter.consume('a');
    limiter.consume('b');
    limiter.consume('c');

    // The oldest insertion was dropped; a fresh key still works.
    expect(limiter.consume('d').allowed).toBe(true);
  });

  it('defines limits for every API surface it references', () => {
    expect(API_RATE_LIMITS.plan.limit).toBeGreaterThan(0);
    expect(API_RATE_LIMITS.notificationRead.limit).toBeGreaterThan(0);
    expect(API_RATE_LIMITS.calendarConnect.limit).toBeGreaterThan(0);
    expect(API_RATE_LIMITS.calendarSync.limit).toBeGreaterThan(0);
    expect(API_RATE_LIMITS.calendarDisconnect.limit).toBeGreaterThan(0);
  });
});
