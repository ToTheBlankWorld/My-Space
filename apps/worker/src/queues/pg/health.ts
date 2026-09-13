/**
 * Readiness for the PostgreSQL queue runtime.
 *
 * Database reachability is reported by the existing `database` probe; this
 * probe answers a different question — did the queue runtime itself start?
 * A worker whose handlers failed to register (or that was launched without
 * its database) must not advertise readiness merely because PostgreSQL is
 * reachable, so the probe reflects the runtime's own startup state.
 */
export interface PgQueueRuntimeHealthState {
  /** Set true only after the runtime and ticker started successfully. */
  started: boolean;
  /** How many queue classes the runtime was configured with. */
  handlerClasses: number;
}

export interface PgQueueHealth {
  readonly probe: () => Promise<{ name: string; ok: boolean }>;
}

/** A runtime with zero configured classes cannot do any work: not ready. */
export const createPgQueueHealth = (state: PgQueueRuntimeHealthState): PgQueueHealth => ({
  probe: () => Promise.resolve({ name: 'pg-queue', ok: state.started && state.handlerClasses > 0 }),
});
