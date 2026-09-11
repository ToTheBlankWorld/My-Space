/**
 * A tiny, dependency-free metrics registry exporting Prometheus text format.
 *
 * The worker needs observability of the shapes it controls — how many jobs
 * start, complete or fail per queue, how long they run, and how much retention
 * a maintenance pass pruned. That did not justify a client library, so this
 * package is a deliberately small counter/gauge/histogram registry with one
 * renderer (`renderPrometheus`) and one plain-structure snapshot (`snapshot`)
 * for tests and logs.
 *
 * All series are held in memory: they are process-lifetime, reset on restart,
 * and correct per instance — exactly what a pull-based `/metrics` scrape of a
 * long-lived worker wants.
 */

export interface MetricDefinition {
  /** Prometheus metric name, including any suffix (e.g. `_total`). */
  name: string;
  /** One-line help string exposed in the `# HELP` comment. */
  help: string;
}

export type Labels = Readonly<Record<string, string>>;

export interface Counter {
  readonly definition: MetricDefinition;
  inc: (labels?: Labels, value?: number) => void;
}

export interface Gauge {
  readonly definition: MetricDefinition;
  set: (value: number, labels?: Labels) => void;
  inc: (labels?: Labels, value?: number) => void;
  dec: (labels?: Labels, value?: number) => void;
}

export interface Histogram {
  readonly definition: MetricDefinition;
  observe: (value: number, labels?: Labels) => void;
}

export type MetricKind = 'counter' | 'gauge' | 'histogram';

/** One line of exposition: a suffix, its labels, and a value. */
export interface CollectedSample {
  /** `''` for counter/gauge, `_bucket`/`_sum`/`_count` for histograms. */
  suffix: string;
  /** The `{k="v",...}` portion, or `''` when there are no labels. */
  labels: string;
  value: number;
}

export interface MetricSeries {
  readonly definition: MetricDefinition;
  readonly kind: MetricKind;
  readonly collect: () => readonly CollectedSample[];
}

export interface Metrics {
  counter: (definition: MetricDefinition) => Counter;
  gauge: (definition: MetricDefinition) => Gauge;
  histogram: (definition: MetricDefinition, buckets: readonly number[]) => Histogram;
  /** Every registered metric, in registration order. */
  series: () => readonly MetricSeries[];
  render: () => string;
  /** A flat `name -> value` map, for logs and assertions. */
  snapshot: () => Record<string, number>;
}

const labelKey = (labels: Labels): string =>
  Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(',');

const escapeLabelValue = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');

class CounterImpl implements Counter {
  readonly definition: MetricDefinition;
  readonly #values = new Map<string, number>();

  constructor(definition: MetricDefinition) {
    this.definition = definition;
  }

  inc(labels: Labels = {}, value = 1): void {
    if (value < 0) {
      throw new RangeError('counter increments must not be negative');
    }
    const key = labelKey(labels);
    this.#values.set(key, (this.#values.get(key) ?? 0) + value);
  }

  collect(): readonly CollectedSample[] {
    return Array.from(this.#values.entries(), ([labels, value]) => ({
      suffix: '',
      labels,
      value,
    }));
  }
}

class GaugeImpl implements Gauge {
  readonly definition: MetricDefinition;
  readonly #values = new Map<string, number>();

  constructor(definition: MetricDefinition) {
    this.definition = definition;
  }

  set(value: number, labels: Labels = {}): void {
    this.#values.set(labelKey(labels), value);
  }

  inc(labels: Labels = {}, value = 1): void {
    this.set((this.#values.get(labelKey(labels)) ?? 0) + value, labels);
  }

  dec(labels: Labels = {}, value = 1): void {
    this.set((this.#values.get(labelKey(labels)) ?? 0) - value, labels);
  }

  collect(): readonly CollectedSample[] {
    return Array.from(this.#values.entries(), ([labels, value]) => ({
      suffix: '',
      labels,
      value,
    }));
  }
}

class HistogramImpl implements Histogram {
  readonly definition: MetricDefinition;
  readonly buckets: readonly number[];
  readonly #values = new Map<string, number>();
  readonly #sums = new Map<string, number>();
  readonly #counts = new Map<string, number>();

  constructor(definition: MetricDefinition, buckets: readonly number[]) {
    if (buckets.length === 0) {
      throw new TypeError('histogram requires at least one bucket boundary');
    }
    for (const bucket of buckets) {
      if (!Number.isFinite(bucket) || bucket <= 0) {
        throw new TypeError(`histogram bucket boundaries must be finite and positive: ${bucket}`);
      }
    }
    this.definition = definition;
    this.buckets = buckets;
  }

  observe(value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) {
      throw new RangeError(`histogram observation must be finite: ${value}`);
    }
    const bucketKey = (bucket: number) =>
      labelKey({
        ...labels,
        le: bucket === Number.POSITIVE_INFINITY ? '+Inf' : String(bucket),
      });

    this.#sums.set(labelKey(labels), (this.#sums.get(labelKey(labels)) ?? 0) + value);
    this.#counts.set(labelKey(labels), (this.#counts.get(labelKey(labels)) ?? 0) + 1);

    for (const bucket of this.buckets) {
      if (value <= bucket) {
        const key = bucketKey(bucket);
        this.#values.set(key, (this.#values.get(key) ?? 0) + 1);
      }
    }
    // +Inf is always observed for every sample, over the base labels.
    const infKey = bucketKey(Number.POSITIVE_INFINITY);
    this.#values.set(infKey, (this.#values.get(infKey) ?? 0) + 1);
  }

  collect(): readonly CollectedSample[] {
    const samples: CollectedSample[] = [];

    for (const [labels, value] of this.#values) {
      samples.push({ suffix: '_bucket', labels, value });
    }
    for (const [labels, value] of this.#sums) {
      samples.push({ suffix: '_sum', labels, value });
    }
    for (const [labels, value] of this.#counts) {
      samples.push({ suffix: '_count', labels, value });
    }

    return samples;
  }
}

const fmt = (value: number): string => {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return String(value);
};

/**
 * Creates a fresh empty registry.
 *
 * Each call returns an isolated set of meters, so tests (and any future
 * service) get their own universe of series.
 */
export const createMetrics = (): Metrics => {
  const registered: MetricSeries[] = [];

  const register = (series: MetricSeries): void => {
    if (registered.some((other) => other.definition.name === series.definition.name)) {
      throw new TypeError(`metric already registered: ${series.definition.name}`);
    }
    registered.push(series);
  };

  return {
    counter: (definition) => {
      const meter = new CounterImpl(definition);
      register({ definition, kind: 'counter', collect: () => meter.collect() });
      return meter;
    },
    gauge: (definition) => {
      const meter = new GaugeImpl(definition);
      register({ definition, kind: 'gauge', collect: () => meter.collect() });
      return meter;
    },
    histogram: (definition, buckets) => {
      const meter = new HistogramImpl(definition, buckets);
      register({ definition, kind: 'histogram', collect: () => meter.collect() });
      return meter;
    },
    series: () => registered,
    render: () => renderPrometheus(registered),
    snapshot: () => {
      const out: Record<string, number> = {};
      for (const series of registered) {
        // A flat total per metric: counters and gauges sum their samples,
        // histograms report their observation count.
        const total = series
          .collect()
          .filter(({ suffix }) => suffix === '' || suffix === '_count')
          .reduce((sum, sample) => sum + sample.value, 0);
        out[series.definition.name] = total;
      }
      return out;
    },
  };
};

/** Renders a collection of series to Prometheus text exposition 0.0.4. */
export const renderPrometheus = (series: readonly MetricSeries[]): string => {
  const lines: string[] = [];

  for (const metric of series) {
    const { definition } = metric;
    lines.push(`# HELP ${definition.name} ${definition.help}`);
    lines.push(`# TYPE ${definition.name} ${metric.kind}`);

    const samples = metric
      .collect()
      .slice()
      .sort((a, b) => {
        const bySuffix = a.suffix.localeCompare(b.suffix);
        if (bySuffix !== 0) {
          return bySuffix;
        }
        return a.labels.localeCompare(b.labels);
      });
    for (const { suffix, labels, value } of samples) {
      const labelText = labels.length > 0 ? `{${labels}}` : '';
      lines.push(`${definition.name}${suffix}${labelText} ${fmt(value)}`);
    }
  }

  return `${lines.join('\n')}\n`;
};
