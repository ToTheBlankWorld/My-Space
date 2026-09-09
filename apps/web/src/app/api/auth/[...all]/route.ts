import { toNextJsHandler } from 'better-auth/next-js';

import { getAuthService } from '@/server/auth';

/**
 * The OAuth endpoints.
 *
 * Everything the provider flow needs lives under `/api/auth`: the redirect to
 * Google, the callback, sign-out and session lookup. The library owns state
 * generation and verification, PKCE, and the cookie contract; this file only
 * mounts it.
 *
 * `force-dynamic` because every request here depends on cookies and must never
 * be served from a cache.
 */
export const dynamic = 'force-dynamic';

const handler = () => toNextJsHandler(getAuthService().auth);

export const GET = async (request: Request): Promise<Response> => handler().GET(request);
export const POST = async (request: Request): Promise<Response> => handler().POST(request);
