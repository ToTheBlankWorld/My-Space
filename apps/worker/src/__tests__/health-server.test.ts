import { createLogger, type Logger } from '@space/logger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHealthServer, type HealthServer, type RuntimeState } from '../health/server';

const silentLogger = (): Logger =>
  createLogger({ name: 'test-worker', level: 'fatal', destination: { write: () => undefined } });

describe('health server', () => {
  let server: HealthServer;
  let state: RuntimeState;
  let origin: string;

  beforeEach(async () => {
    state = { ready: false };
    server = createHealthServer({
      logger: silentLogger(),
      state,
      serviceName: 'test-worker',
    });
    const port = await server.listen(0);
    origin = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  it('reports liveness regardless of readiness', async () => {
    const response = await fetch(`${origin}/healthz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'test-worker',
    });
  });

  it('answers 503 on /readyz until the process finishes booting', async () => {
    const draining = await fetch(`${origin}/readyz`);
    expect(draining.status).toBe(503);
    await expect(draining.json()).resolves.toMatchObject({ status: 'draining' });

    state.ready = true;

    const ready = await fetch(`${origin}/readyz`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ status: 'ready' });
  });

  it('returns 404 for unknown paths', async () => {
    const response = await fetch(`${origin}/admin`);

    expect(response.status).toBe(404);
  });

  it('rejects non-read methods', async () => {
    const response = await fetch(`${origin}/healthz`, { method: 'POST' });

    expect(response.status).toBe(405);
  });

  it('reports each readiness probe by name, and nothing else', async () => {
    await server.close();

    state = { ready: true };
    server = createHealthServer({
      logger: silentLogger(),
      state,
      serviceName: 'test-worker',
      probes: [
        () => Promise.resolve({ name: 'database', ok: true }),
        () => Promise.resolve({ name: 'queue', ok: true }),
      ],
    });
    const port = await server.listen(0);

    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'ready',
      service: 'test-worker',
      dependencies: { database: true, queue: true },
    });
  });

  it('answers 503 when a dependency is down, without saying why', async () => {
    await server.close();

    state = { ready: true };
    server = createHealthServer({
      logger: silentLogger(),
      state,
      serviceName: 'test-worker',
      probes: [() => Promise.resolve({ name: 'database', ok: false })],
    });
    const port = await server.listen(0);

    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(response.status).toBe(503);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      status: 'degraded',
      service: 'test-worker',
      dependencies: { database: false },
    });
    // An unauthenticated endpoint must not leak host names or driver errors.
    expect(JSON.stringify(body)).not.toMatch(/postgres|connect|ECONN|password/i);
  });

  it('does not run dependency probes for liveness', async () => {
    await server.close();

    let probeCalls = 0;
    state = { ready: true };
    server = createHealthServer({
      logger: silentLogger(),
      state,
      serviceName: 'test-worker',
      probes: [
        () => {
          probeCalls += 1;
          return Promise.resolve({ name: 'database', ok: false });
        },
      ],
    });
    const port = await server.listen(0);

    // A database outage must not make the platform restart a healthy process.
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(200);
    expect(probeCalls).toBe(0);
  });

  it('closes without error and can be closed twice', async () => {
    await expect(server.close()).resolves.toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();
  });
});
