import { describe, expect, it, vi } from 'vitest';

import { FixedClock, SystemClock, systemClock } from '../clock';

describe('SystemClock', () => {
  it('reports the host clock', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_774_771_200_000);

    const clock = new SystemClock();

    expect(clock.nowMs()).toBe(1_774_771_200_000);
    expect(clock.now().toISOString()).toBe('2026-03-29T08:00:00.000Z');
    expect(clock.nowIso()).toBe('2026-03-29T08:00:00.000Z');

    vi.restoreAllMocks();
  });

  it('exposes a shared instance for composition roots', () => {
    expect(systemClock).toBeInstanceOf(SystemClock);
  });

  it('returns a fresh Date each call, so a caller cannot corrupt the clock', () => {
    const clock = new SystemClock();
    const first = clock.now();
    first.setUTCFullYear(1999);

    expect(clock.now().getUTCFullYear()).not.toBe(1999);
  });
});

describe('FixedClock', () => {
  it('accepts an ISO string, a Date or epoch milliseconds', () => {
    const fromString = new FixedClock('2026-03-29T09:00:00.000Z');
    const fromDate = new FixedClock(new Date('2026-03-29T09:00:00.000Z'));
    const fromMs = new FixedClock(1_774_774_800_000);

    expect(fromString.nowMs()).toBe(fromDate.nowMs());
    expect(fromDate.nowMs()).toBe(fromMs.nowMs());
  });

  it('does not move on its own', () => {
    const clock = new FixedClock('2026-03-29T09:00:00.000Z');

    expect(clock.nowIso()).toBe('2026-03-29T09:00:00.000Z');
    expect(clock.nowIso()).toBe('2026-03-29T09:00:00.000Z');
  });

  it('advances by milliseconds, minutes and days', () => {
    const clock = new FixedClock('2026-03-29T09:00:00.000Z');

    expect(clock.advanceMinutes(90).nowIso()).toBe('2026-03-29T10:30:00.000Z');
    expect(clock.advanceDays(2).nowIso()).toBe('2026-03-31T10:30:00.000Z');
    expect(clock.advance(-30_000).nowIso()).toBe('2026-03-31T10:29:30.000Z');
  });

  it('jumps to an absolute instant', () => {
    const clock = new FixedClock('2026-03-29T09:00:00.000Z');

    expect(clock.set('2027-01-01T00:00:00.000Z').nowIso()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('rejects an unparseable instant instead of silently sitting on NaN', () => {
    expect(() => new FixedClock('not-a-date')).toThrow(TypeError);
  });

  it('hands out defensive copies', () => {
    const clock = new FixedClock('2026-03-29T09:00:00.000Z');
    clock.now().setUTCFullYear(1999);

    expect(clock.nowIso()).toBe('2026-03-29T09:00:00.000Z');
  });
});
