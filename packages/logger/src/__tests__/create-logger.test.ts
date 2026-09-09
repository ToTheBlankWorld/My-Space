import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from '../create-logger';

const collect = (): { stream: Writable; records: () => Record<string, unknown>[] } => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });

  return {
    stream,
    records: () =>
      lines
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
};

describe('createLogger', () => {
  it('emits structured JSON with the service name and a string level', () => {
    const sink = collect();
    const logger = createLogger({ name: 'test-service', level: 'info', destination: sink.stream });

    logger.info({ jobId: 'job-1' }, 'job accepted');

    const [record] = sink.records();
    expect(record).toMatchObject({
      level: 'info',
      service: 'test-service',
      jobId: 'job-1',
      msg: 'job accepted',
    });
    expect(typeof record?.time).toBe('string');
  });

  it('redacts credential-shaped fields at any nesting level', () => {
    const sink = collect();
    const logger = createLogger({ name: 'test-service', level: 'info', destination: sink.stream });

    logger.info({ token: 'plain-token', user: { apiKey: 'plain-key' } }, 'connected');

    const [record] = sink.records();
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('plain-token');
    expect(serialized).not.toContain('plain-key');
    expect(record?.token).toBe('[redacted]');
  });

  it('drops records below the configured level', () => {
    const sink = collect();
    const logger = createLogger({ name: 'test-service', level: 'warn', destination: sink.stream });

    logger.debug('ignored');
    logger.warn('kept');

    expect(sink.records()).toHaveLength(1);
    expect(sink.records()[0]?.msg).toBe('kept');
  });

  it('merges static bindings into every record', () => {
    const sink = collect();
    const logger = createLogger({
      name: 'test-service',
      level: 'info',
      bindings: { region: 'eu-west-1' },
      destination: sink.stream,
    });

    logger.info('boot');

    expect(sink.records()[0]).toMatchObject({ region: 'eu-west-1' });
  });
});
