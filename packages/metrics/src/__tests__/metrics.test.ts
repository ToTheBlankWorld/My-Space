import { describe, expect, it } from 'vitest';

import { createMetrics, renderPrometheus } from '../metrics';

describe('counters', () => {
  it('accumulates across label sets and exposes stable series', () => {
    const metrics = createMetrics();
    const started = metrics.counter({ name: 'worker_jobs_started_total', help: 'Jobs started' });

    started.inc({ queue: 'planning' });
    started.inc({ queue: 'planning' });
    started.inc({ queue: 'planning' }, 3);
    started.inc({ queue: 'notifications' });

    expect(metrics.render()).toBe(
      [
        '# HELP worker_jobs_started_total Jobs started',
        '# TYPE worker_jobs_started_total counter',
        'worker_jobs_started_total{queue="notifications"} 1',
        'worker_jobs_started_total{queue="planning"} 5',
        '',
      ].join('\n'),
    );
  });

  it('rejects a negative increment', () => {
    const metrics = createMetrics();
    const started = metrics.counter({ name: 'worker_jobs_started_total', help: 'Jobs started' });

    expect(() => started.inc({}, -1)).toThrowError('must not be negative');
  });
});

describe('gauges', () => {
  it('sets, increments and decrements a value per label set', () => {
    const metrics = createMetrics();
    const gauge = metrics.gauge({ name: 'space_connections', help: 'Active connections' });

    gauge.set(2, { status: 'connected' });
    gauge.inc({ status: 'connected' });
    gauge.dec({ status: 'connected' });
    gauge.set(4, { status: 'connected' });

    expect(metrics.render()).toBe(
      [
        '# HELP space_connections Active connections',
        '# TYPE space_connections gauge',
        'space_connections{status="connected"} 4',
        '',
      ].join('\n'),
    );
  });
});

describe('histograms', () => {
  it('distributes observations into buckets and exposes sum and count', () => {
    const metrics = createMetrics();
    const duration = metrics.histogram(
      { name: 'worker_job_duration_seconds', help: 'Job duration' },
      [0.5, 1],
    );

    duration.observe(0.25, { queue: 'planning' });
    duration.observe(0.9, { queue: 'planning' });
    duration.observe(2, { queue: 'planning' });

    const output = metrics.render();

    expect(output).toBe(
      [
        '# HELP worker_job_duration_seconds Job duration',
        '# TYPE worker_job_duration_seconds histogram',
        'worker_job_duration_seconds_bucket{le="+Inf",queue="planning"} 3',
        'worker_job_duration_seconds_bucket{le="0.5",queue="planning"} 1',
        'worker_job_duration_seconds_bucket{le="1",queue="planning"} 2',
        'worker_job_duration_seconds_count{queue="planning"} 3',
        'worker_job_duration_seconds_sum{queue="planning"} 3.15',
        '',
      ].join('\n'),
    );
  });

  it('rejects an empty or invalid bucket list up front', () => {
    const metrics = createMetrics();

    expect(() => metrics.histogram({ name: 'h', help: 'h' }, [])).toThrowError(
      'at least one bucket',
    );
    expect(() => metrics.histogram({ name: 'h2', help: 'h2' }, [0])).toThrowError(
      'finite and positive',
    );
  });

  it('rejects a non-finite observation', () => {
    const metrics = createMetrics();
    const duration = metrics.histogram({ name: 'd', help: 'd' }, [1]);

    expect(() => duration.observe(Number.NaN)).toThrowError('finite');
  });
});

describe('registry', () => {
  it('forbids registering the same metric name twice', () => {
    const metrics = createMetrics();
    const definition = { name: 'dup_total', help: 'A' };

    metrics.counter(definition);

    expect(() => metrics.gauge(definition)).toThrowError('already registered');
  });

  it('renders counters deterministically', () => {
    const metrics = createMetrics();
    const started = metrics.counter({ name: 'worker_jobs_started_total', help: 'Jobs started' });
    started.inc({ queue: 'planning' });
    started.inc({ queue: 'notifications' });

    const output = metrics.render();

    expect(output).toBe(
      [
        '# HELP worker_jobs_started_total Jobs started',
        '# TYPE worker_jobs_started_total counter',
        'worker_jobs_started_total{queue="notifications"} 1',
        'worker_jobs_started_total{queue="planning"} 1',
        '',
      ].join('\n'),
    );
  });

  it('snapshots a flat total per metric for logs and assertions', () => {
    const metrics = createMetrics();
    const started = metrics.counter({ name: 'worker_jobs_started_total', help: 'Jobs started' });
    const gauge = metrics.gauge({ name: 'space_connections', help: 'Connections' });
    const duration = metrics.histogram(
      { name: 'worker_job_duration_seconds', help: 'Job duration' },
      [1],
    );

    started.inc({ queue: 'planning' });
    started.inc({ queue: 'planning' });
    gauge.set(2, { status: 'connected' });
    duration.observe(0.5);
    duration.observe(2);

    expect(metrics.snapshot()).toEqual({
      worker_jobs_started_total: 2,
      space_connections: 2,
      worker_job_duration_seconds: 2,
    });
  });
});

describe('renderPrometheus', () => {
  it('escapes label values that could corrupt the exposition', () => {
    const metrics = createMetrics();
    const started = metrics.counter({ name: 'worker_jobs_started_total', help: 'Jobs started' });

    started.inc({ queue: 'a"b\nc' });

    expect(renderPrometheus(metrics.series())).toContain(
      'worker_jobs_started_total{queue="a\\"b\\nc"} 1',
    );
  });
});
