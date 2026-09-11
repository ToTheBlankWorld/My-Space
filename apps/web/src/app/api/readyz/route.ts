import { NextResponse } from 'next/server';

import { getDatabase } from '@/server/database';

/**
 * GET /api/readyz
 *
 * Readiness probe for platform health checks: should this instance receive
 * traffic?
 *
 * Runs a real database round-trip and reports one dependency by name and
 * boolean only — never an error message, host, or driver code, because the
 * endpoint is unauthenticated. A database outage degrades to 503 so an
 * orchestrator can route traffic elsewhere.
 */
export const GET = async (): Promise<NextResponse> => {
  const database = await checkDatabase();

  return NextResponse.json(
    {
      status: database ? 'ready' : 'degraded',
      service: 'web',
      dependencies: { database },
    },
    {
      status: database ? 200 : 503,
      headers: { 'cache-control': 'no-store' },
    },
  );
};

const checkDatabase = async (): Promise<boolean> => {
  try {
    await getDatabase().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
};
