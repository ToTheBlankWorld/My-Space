import type { Counter, Gauge, Metrics } from '@space/metrics';

/**
 * Metric families for the PostgreSQL job queue.
 *
 * All series live in the shared process registry alongside the generic
 * application metrics.
 *
 * Counters and the depth gauge are labelled per queue; the age and lag gauges
 * are process-wide (one claim query each per maintenance tick, not per queue).
 */
export interface PgQueueMetrics {
  /** Jobs claimed and started from the PostgreSQL queue. */
  claimed: Counter;
  /** Jobs that finished successfully. */
  completed: Counter;
  /** Jobs whose handler threw (any outcome). */
  failed: Counter;
  /** Failures that still had retry budget — rescheduled with backoff. */
  retried: Counter;
  /** Jobs that hit DEAD (budget exhausted, permanent failure, or reaped past budget). */
  dead: Counter;
  /** Rows the lease reaper recovered (returned to PENDING). */
  reaped: Counter;
  /** Pending rows waiting per queue. */
  depth: Gauge;
  /** Age of the oldest pending job, in seconds. */
  oldestPendingSeconds: Gauge;
  /** How overdue the most due schedule is, in seconds (0 = healthy). */
  scheduleLagSeconds: Gauge;
}

export const createPgQueueMetrics = (metrics: Metrics): PgQueueMetrics => ({
  claimed: metrics.counter({
    name: 'worker_pg_jobs_claimed_total',
    help: 'Background jobs claimed from the PostgreSQL queue',
  }),
  completed: metrics.counter({
    name: 'worker_pg_jobs_completed_total',
    help: 'Background jobs completed successfully',
  }),
  failed: metrics.counter({
    name: 'worker_pg_jobs_failed_total',
    help: 'Background jobs whose handler raised',
  }),
  retried: metrics.counter({
    name: 'worker_pg_jobs_retried_total',
    help: 'Background jobs rescheduled with backoff after a failure',
  }),
  dead: metrics.counter({
    name: 'worker_pg_jobs_dead_total',
    help: 'Background jobs moved to DEAD',
  }),
  reaped: metrics.counter({
    name: 'worker_pg_jobs_reaped_total',
    help: 'Expired-lease jobs recovered back to PENDING by the reaper',
  }),
  depth: metrics.gauge({
    name: 'worker_pg_queue_depth',
    help: 'Pending jobs waiting per queue',
  }),
  oldestPendingSeconds: metrics.gauge({
    name: 'worker_pg_oldest_pending_seconds',
    help: 'Age of the oldest pending job in seconds',
  }),
  scheduleLagSeconds: metrics.gauge({
    name: 'worker_pg_schedule_lag_seconds',
    help: 'How overdue the most due job schedule is, in seconds',
  }),
});
