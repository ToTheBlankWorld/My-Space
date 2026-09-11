import type { Clock } from '@space/time';

/**
 * Rate limiting for the in-app JSON API surface.
 *
 * Same shape as the auth package's limiter (fixed window, in-memory), but kept
 * local so the web app's Vitest setup — which only aliases `@space/time` and
 * `@space/types` — can unit-test it directly.
 *
 * Honest about what it is: per-process memory is not a distributed control.
 * It raises the cost of trivial abuse while a single instance is running and
 * gives the API a bounded default; it is not a substitute for a shared
 * limiter (Redis) on a multi-replica deployment.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: Date;
}

export interface RateLimitRule {
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
 * Keys are scoped by the caller (`plan:<userId>`), so one user cannot exhaust
 * another's budget. Windows that expire are reused; the map is bounded so an
 * attacker varying the key cannot grow it without limit.
 */
export class WebRateLimiter {
  readonly #windows = new Map<string, Window>();
  readonly #rule: RateLimitRule;
  readonly #clock: Clock;
  readonly #maxKeys: number;

  constructor(rule: RateLimitRule, clock: Clock, maxKeys = 10_000) {
    this.#rule = rule;
    this.#clock = clock;
    this.#maxKeys = maxKeys;
  }

  consume(key: string, cost = 1): RateLimitDecision {
    const nowMs = this.#clock.nowMs();
    const existing = this.#windows.get(key);

    if (!existing || existing.resetAtMs <= nowMs) {
      this.#evictIfNeeded(nowMs);
      const window: Window = { count: cost, resetAtMs: nowMs + this.#rule.windowMs };
      this.#windows.set(key, window);

      return {
        allowed: cost <= this.#rule.limit,
        remaining: Math.max(this.#rule.limit - cost, 0),
        resetAt: new Date(window.resetAtMs),
      };
    }

    existing.count += cost;

    return {
      allowed: existing.count <= this.#rule.limit,
      remaining: Math.max(this.#rule.limit - existing.count, 0),
      resetAt: new Date(existing.resetAtMs),
    };
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

    if (this.#windows.size >= this.#maxKeys) {
      const oldest = this.#windows.keys().next();
      if (!oldest.done) {
        this.#windows.delete(oldest.value);
      }
    }
  }
}

/** Limits applied to the in-app JSON API surface. */
export const API_RATE_LIMITS = {
  plan: { limit: 10, windowMs: 60_000 },
  notificationRead: { limit: 60, windowMs: 60_000 },
  calendarConnect: { limit: 10, windowMs: 60_000 },
  calendarSync: { limit: 20, windowMs: 60_000 },
  calendarDisconnect: { limit: 10, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

export type ApiRateLimitScope = keyof typeof API_RATE_LIMITS;
