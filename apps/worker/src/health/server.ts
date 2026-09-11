import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { Logger } from '@space/logger';

/** Mutable liveness/readiness state owned by the worker bootstrap. */
export interface RuntimeState {
  /** False until boot finishes, and again once shutdown begins. */
  ready: boolean;
}

/**
 * An extra condition that must hold before this instance accepts work.
 *
 * Returns the dependency's name and whether it answered. A probe must never
 * return detail about *why* it failed: `/readyz` is unauthenticated.
 */
export type ReadinessProbe = () => Promise<{ name: string; ok: boolean }>;

export interface HealthServerOptions {
  logger: Logger;
  state: RuntimeState;
  /** Reported in the payload so a rolling deploy can be identified. */
  serviceName: string;
  /**
   * Dependency checks run on every `/readyz` request.
   *
   * Liveness (`/healthz`) deliberately does not run them: a database outage
   * means this instance should stop receiving work, not that the platform should
   * restart the process.
   */
  probes?: readonly ReadinessProbe[];
  /**
   * Optional Prometheus exposition served at `/metrics`.
   *
   * Like the probes it is unauthenticated — the health server binds to an
   * internal port, not the public surface, and the exposition contains no
   * request data.
   */
  metrics?: { render: () => string };
}

export interface HealthServer {
  /** Starts listening and resolves with the bound port (useful when port is 0). */
  listen: (port: number) => Promise<number>;
  close: () => Promise<void>;
  readonly raw: Server;
}

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
};

/**
 * A minimal HTTP surface for platform health checks.
 *
 * Railway (and any container orchestrator) needs an endpoint to decide whether
 * an instance is alive and whether it should receive work. It also gives the
 * process a legitimate reason to keep the event loop open, which avoids the
 * anti-pattern of holding the worker up with an idle timer.
 *
 * `/healthz` answers "is the process alive" and `/readyz` answers "should this
 * instance be given work" — during shutdown the first stays green while the
 * second turns red, so a deploy can drain instead of dropping requests.
 */
export const createHealthServer = ({
  logger,
  state,
  serviceName,
  probes = [],
  metrics,
}: HealthServerOptions): HealthServer => {
  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const path = (request.url ?? '/').split('?')[0];

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }

    switch (path) {
      case '/healthz':
        sendJson(response, 200, {
          status: 'ok',
          service: serviceName,
          uptimeSeconds: Math.round(process.uptime()),
        });
        return;
      case '/readyz':
        void respondWithReadiness(response);
        return;
      case '/metrics':
        respondWithMetrics(response);
        return;
      default:
        sendJson(response, 404, { error: 'not_found' });
    }
  };

  /**
   * Answers `/metrics`.
   *
   * When no registry is configured the route responds 404 so a probe that
   * targets it fails loudly instead of silently scraping nothing.
   */
  const respondWithMetrics = (response: ServerResponse): void => {
    if (!metrics) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }

    const body = metrics.render();
    response.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    response.end(body);
  };

  /**
   * Answers `/readyz`.
   *
   * Reports each dependency by name and boolean only — never an error message,
   * a host, or a driver code.
   */
  const respondWithReadiness = async (response: ServerResponse): Promise<void> => {
    if (!state.ready) {
      sendJson(response, 503, { status: 'draining', service: serviceName });
      return;
    }

    const results = await Promise.all(probes.map((probe) => probe()));
    const dependencies = Object.fromEntries(results.map(({ name, ok }) => [name, ok]));
    const healthy = results.every(({ ok }) => ok);

    sendJson(response, healthy ? 200 : 503, {
      status: healthy ? 'ready' : 'degraded',
      service: serviceName,
      dependencies,
    });
  };

  const server = createServer(handle);

  return {
    raw: server,
    listen: (port) =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          server.off('error', reject);
          const address = server.address();
          const boundPort = typeof address === 'object' && address !== null ? address.port : port;
          logger.info({ port: boundPort }, 'health endpoints listening');
          resolve(boundPort);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        // `closeIdleConnections` prevents keep-alive sockets from holding the
        // process open for the full keep-alive timeout during a deploy.
        server.closeIdleConnections();
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
};
