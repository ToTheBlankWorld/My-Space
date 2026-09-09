import type { Clock } from '@space/time';

/**
 * The rate-limiting seam.
 *
 * Real distributed limiting needs shared state, which means Redis, which is
 * Stage 7. What exists now is the *interface* every authentication entry point
 * is written against, plus an in-memory implementation good enough for a single
 * process, so Stage 7 replaces one class instead of threading a new concept
 * through call sites.
 *
 * Endpoints that will need it, and why:
 *
 * | Endpoint                          | Risk without a limit                       |
 * | --------------------------------- | ------------------------------------------ |
 * | `POST /api/auth/sign-in/social`   | Cheap way to spray OAuth state rows        |
 * | `GET  /api/auth/callback/google`  | Forged callbacks probing state handling    |
 * | `POST /api/auth/sign-out`         | Session-table churn                        |
 * | onboarding submission             | Repeated writes to preference tables       |
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Requests still available in the current window. */
  readonly remaining: number;
  /** When the window resets. */
  readonly resetAt: Date;
}

export interface RateLimiter {
  /**
   * Records one attempt against `key` and reports whether it may proceed.
   *
   * `key` must not be raw user input: callers hash or scope it (for example
   * `signin:<ip>`), so one caller cannot exhaust another's budget.
   */
  consume: (key: string, cost?: number) => Promise<RateLimitDecision>;
}

export interface RateLimitRule {
  /** Requests permitted per window. */
  readonly limit: number;
  readonly windowMs: number;
}

interface Window {
  count: number;
  resetAtMs: number;
}

/**
 * A fixed-window limiter held in process memory.
 *
 * Honest about what it is: per-instance, lost on restart, and useless across
 * more than one replica. It raises the cost of trivial abuse and gives the
 * interface a working default; it is not a security control to rely on.
 */
export class InMemoryRateLimiter implements RateLimiter {
  readonly #windows = new Map<string, Window>();
  readonly #rule: RateLimitRule;
  readonly #clock: Clock;
  /** Bounds memory: an attacker varying the key must not grow the map forever. */
  readonly #maxKeys: number;

  constructor(rule: RateLimitRule, clock: Clock, maxKeys = 10_000) {
    this.#rule = rule;
    this.#clock = clock;
    this.#maxKeys = maxKeys;
  }

  consume(key: string, cost = 1): Promise<RateLimitDecision> {
    const nowMs = this.#clock.nowMs();
    const existing = this.#windows.get(key);

    if (!existing || existing.resetAtMs <= nowMs) {
      this.#evictIfNeeded(nowMs);
      const window: Window = { count: cost, resetAtMs: nowMs + this.#rule.windowMs };
      this.#windows.set(key, window);

      return Promise.resolve({
        allowed: cost <= this.#rule.limit,
        remaining: Math.max(this.#rule.limit - cost, 0),
        resetAt: new Date(window.resetAtMs),
      });
    }

    existing.count += cost;

    return Promise.resolve({
      allowed: existing.count <= this.#rule.limit,
      remaining: Math.max(this.#rule.limit - existing.count, 0),
      resetAt: new Date(existing.resetAtMs),
    });
  }

  #evictIfNeeded(nowMs: number): void {
    if (this.#windows.size < this.#maxKeys) {
      return;
    }

    for (const [key, window] of this.#windows) {
      if (window.resetAtMs <= nowMs) {
        this.#windows.delete(key);
      }
    }

    // Still full of live windows: drop the oldest insertion to stay bounded.
    if (this.#windows.size >= this.#maxKeys) {
      const oldest = this.#windows.keys().next();
      if (!oldest.done) {
        this.#windows.delete(oldest.value);
      }
    }
  }
}

/** Limits applied to the authentication surface. */
export const AUTH_RATE_LIMITS = {
  signIn: { limit: 10, windowMs: 60_000 },
  callback: { limit: 20, windowMs: 60_000 },
  onboarding: { limit: 20, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;
