import { NextResponse } from 'next/server';

/**
 * GET /api/healthz
 *
 * Liveness probe for the web process: is this instance alive?
 *
 * Deliberately does not touch the database. A database outage means traffic
 * should be routed away via `/readyz`, not that the platform should restart a
 * healthy process. The response is never cached so an orchestrator always sees
 * the current instant.
 */
export const GET = (): NextResponse =>
  NextResponse.json(
    {
      status: 'ok',
      service: 'web',
      uptimeSeconds: Math.round(process.uptime()),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
