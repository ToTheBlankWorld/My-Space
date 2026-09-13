/**
 * In-process fixed-window rate pacing for the PostgreSQL queue handlers.
 *
 * Budgets (10 syncs/min, 10 plans/min, 20 deliveries/min, 2 reviews/2 min)
 * live in process memory, so they are correct for the current single-Railway-
 * worker deployment but are NOT distributed: if the worker is ever scaled
 * horizontally, each replica would enforce its own budget. That scaling
 * boundary is documented and deliberate — no external service is introduced
 * for it.
 *
 * Pacing is throughput shaping, not correctness: a paced-out job still runs,
 * just slightly later, so a process restart losing a window's memory is
 * harmless.
 */
export interface PacerConfig {
  /** Maximum takes per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface Pacer {
  /** Resolves when the caller may proceed; never rejects. */
  take: () => Promise<void>;
}

export const createPacer = (
  { max, windowMs }: PacerConfig,
  nowMs: () => number = () => Date.now(),
): Pacer => {
  const takenAt: number[] = [];

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Pacing must never hold a shutdown open.
      timer.unref();
    });

  return {
    take: async (): Promise<void> => {
      const now = nowMs();
      // Drop timestamps outside the current window.
      while (takenAt.length > 0 && takenAt[0]! <= now - windowMs) {
        takenAt.shift();
      }

      if (takenAt.length < max) {
        takenAt.push(now);
        return;
      }

      const oldest = takenAt[0]!;
      const delay = oldest + windowMs - now;
      await wait(Math.max(delay, 0));
      takenAt.push(nowMs());
    },
  };
};
