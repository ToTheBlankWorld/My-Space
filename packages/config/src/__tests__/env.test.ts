import { describe, expect, it } from 'vitest';

import { EnvironmentError } from '../define-env';
import { loadWebServerEnv, webServerEnvSchema } from '../web';
import { loadWorkerEnv } from '../worker';

describe('worker environment', () => {
  it('boots from an empty environment using safe defaults', () => {
    const env = loadWorkerEnv({});

    expect(env).toEqual({
      NODE_ENV: 'development',
      WORKER_NAME: 'space-worker',
      LOG_LEVEL: 'info',
      HEALTH_PORT: 8080,
      SHUTDOWN_TIMEOUT_MS: 10_000,
      CALENDAR_SYNC_INTERVAL_MINUTES: 15,
      PLANNING_MAX_TASKS_PER_PLAN: 100,
      APP_URL: 'http://localhost:3000',
      AGENTMAIL_BASE_URL: 'https://api.agentmail.dev',
      NOTIFICATION_SWEEP_INTERVAL_MINUTES: 5,
      AUTONOMY_REVIEW_INTERVAL_MINUTES: 5,
      MAINTENANCE_INTERVAL_MINUTES: 1440,
      EVENT_LOG_RETENTION_DAYS: 90,
      AGENT_ACTION_RETENTION_DAYS: 90,
      NOTIFICATION_RETENTION_DAYS: 90,
      EMAIL_LOG_RETENTION_DAYS: 90,
      SESSION_RETENTION_DAYS: 30,
      VERIFICATION_RETENTION_DAYS: 7,
      CALENDAR_EVENT_RETENTION_DAYS: 90,
    });
  });

  it('coerces numeric variables, which arrive as strings', () => {
    const env = loadWorkerEnv({ HEALTH_PORT: '9000', SHUTDOWN_TIMEOUT_MS: '2500' });

    expect(env.HEALTH_PORT).toBe(9000);
    expect(env.SHUTDOWN_TIMEOUT_MS).toBe(2500);
  });

  it('rejects an unknown log level and names the offending key', () => {
    expect(() => loadWorkerEnv({ LOG_LEVEL: 'verbose' })).toThrow(EnvironmentError);

    try {
      loadWorkerEnv({ LOG_LEVEL: 'verbose' });
    } catch (error) {
      expect((error as EnvironmentError).issues.join()).toContain('LOG_LEVEL');
    }
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadWorkerEnv({ HEALTH_PORT: '70000' })).toThrow(EnvironmentError);
  });

  it('returns a frozen snapshot so configuration cannot drift at runtime', () => {
    const env = loadWorkerEnv({});

    expect(Object.isFrozen(env)).toBe(true);
  });
});

describe('web environment', () => {
  it('defaults APP_URL to the local development origin', () => {
    expect(loadWebServerEnv({}).APP_URL).toBe('http://localhost:3000');
  });

  it('rejects a non-http APP_URL', () => {
    expect(() => loadWebServerEnv({ APP_URL: 'file:///etc/passwd' })).toThrow(EnvironmentError);
  });

  it('keeps the client schema free of any server-only key', () => {
    // A regression here means a secret could be inlined into the browser bundle.
    const serverKeys = Object.keys(webServerEnvSchema.shape);

    expect(serverKeys).toEqual(['NODE_ENV', 'APP_URL']);
  });
});
