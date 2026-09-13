import { createMetrics } from '@space/metrics';
import { describe, expect, it } from 'vitest';

import { createPgQueueMetrics } from '../metrics';

/**
 * The PostgreSQL queue metric families must register cleanly into the shared
 * process registry (alongside the generic application metrics like the
 * retention gauge) and render in Prometheus text format with labels intact.
 */
describe('pg queue metrics', () => {
  it('coexists with generic application metric families in one registry', () => {
    const metrics = createMetrics();
    metrics.gauge({ name: 'space_retention_pruned_rows', help: 'Rows pruned by the latest maintenance pass' });
    expect(() => createPgQueueMetrics(metrics)).not.toThrow();
  });

  it('guards its own names against double registration', () => {
    const metrics = createMetrics();
    createPgQueueMetrics(metrics);
    expect(() => createPgQueueMetrics(metrics)).toThrow(/already registered/);
  });

  it('renders counters, gauges and labels in Prometheus format', () => {
    const metrics = createMetrics();
    const pg = createPgQueueMetrics(metrics);

    pg.claimed.inc({ queue: 'planning' });
    pg.claimed.inc({ queue: 'planning' });
    pg.dead.inc({ queue: 'notifications' });
    pg.depth.set(7, { queue: 'calendar-sync' });
    pg.oldestPendingSeconds.set(42);
    pg.scheduleLagSeconds.set(0);

    const text = metrics.render();
    expect(text).toContain('worker_pg_jobs_claimed_total{queue="planning"} 2');
    expect(text).toContain('worker_pg_jobs_dead_total{queue="notifications"} 1');
    expect(text).toContain('worker_pg_queue_depth{queue="calendar-sync"} 7');
    expect(text).toContain('worker_pg_oldest_pending_seconds 42');
    expect(text).toContain('worker_pg_schedule_lag_seconds 0');
  });
});
