import type { IsoDateTime } from '@space/types';

/**
 * The single source of "now" in Space.
 *
 * Every decision the deterministic engines make is a function of the current
 * instant, so reading the wall clock implicitly would make planning impossible
 * to test and impossible to replay. Code takes a `Clock`; tests inject
 * {@link FixedClock}; production injects {@link SystemClock}.
 *
 * A repo-wide ESLint rule forbids bare `new Date()`, so this module is the only
 * sanctioned place where the system clock is read.
 */
export interface Clock {
  /** The current instant. Always a fresh object: callers may mutate their copy. */
  now: () => Date;
  /** The current instant in milliseconds since the Unix epoch. */
  nowMs: () => number;
  /** The current instant as an RFC 3339 string in UTC. */
  nowIso: () => IsoDateTime;
}

/**
 * Reads the host's clock.
 *
 * `Date.now()` is used rather than the zero-argument `Date` constructor so the
 * lint rule that guards the rest of the codebase needs no exception here.
 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date(Date.now());
  }

  nowMs(): number {
    return Date.now();
  }

  nowIso(): IsoDateTime {
    return new Date(Date.now()).toISOString() as IsoDateTime;
  }
}

/** Process-wide system clock. Inject this at composition roots only. */
export const systemClock: Clock = new SystemClock();

/**
 * A clock that only moves when a test moves it.
 *
 * Use it for anything that must be reproducible: seed data, scheduling
 * decisions, deadline arithmetic, retry back-off.
 *
 * @example
 * const clock = new FixedClock('2026-03-29T09:00:00.000Z');
 * clock.advanceMinutes(90);
 * clock.nowIso(); // '2026-03-29T10:30:00.000Z'
 */
export class FixedClock implements Clock {
  #currentMs: number;

  constructor(instant: Date | number | string) {
    this.#currentMs = FixedClock.#toMs(instant);
  }

  static #toMs(instant: Date | number | string): number {
    const ms = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();

    if (Number.isNaN(ms)) {
      throw new TypeError(`FixedClock received an invalid instant: ${String(instant)}`);
    }

    return ms;
  }

  now(): Date {
    return new Date(this.#currentMs);
  }

  nowMs(): number {
    return this.#currentMs;
  }

  nowIso(): IsoDateTime {
    return new Date(this.#currentMs).toISOString() as IsoDateTime;
  }

  /** Moves the clock forward (or backward, with a negative value). */
  advance(milliseconds: number): this {
    this.#currentMs += milliseconds;
    return this;
  }

  advanceMinutes(minutes: number): this {
    return this.advance(minutes * 60_000);
  }

  advanceDays(days: number): this {
    return this.advance(days * 86_400_000);
  }

  /** Jumps to an absolute instant. */
  set(instant: Date | number | string): this {
    this.#currentMs = FixedClock.#toMs(instant);
    return this;
  }
}
