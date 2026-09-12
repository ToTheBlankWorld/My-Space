import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@space/logger';

const mocks = vi.hoisted(() => ({
  createDatabaseClient: vi.fn(),
  checkDatabaseHealth: vi.fn(),
}));

vi.mock('@space/database', () => mocks);

import { connectDatabase } from '../database';

const silentLogger = (): Logger => ({ child: () => silentLogger() }) as unknown as Logger;

describe('connectDatabase', () => {
  it('forwards the configured health timeout into the database health check', async () => {
    const client = { $disconnect: vi.fn() };
    const logger = silentLogger();
    mocks.createDatabaseClient.mockReturnValue(client);
    mocks.checkDatabaseHealth.mockResolvedValue({ status: 'ok', latencyMs: 1 });

    const connection = connectDatabase({
      connectionString: 'postgresql://user:pass@db:5432/space',
      logger,
      healthTimeoutMs: 5_000,
    });

    await expect(connection.probe()).resolves.toEqual({ name: 'database', ok: true });
    expect(mocks.checkDatabaseHealth).toHaveBeenCalledWith(client, {
      timeoutMs: 5_000,
      logger,
    });
  });
});
