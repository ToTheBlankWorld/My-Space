import { NextResponse, type NextRequest } from 'next/server';

import { readRequestId, REQUEST_ID_HEADER } from '@/lib/request-id';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * A per-request Content-Security-Policy, the same posture the app had when the
 * policy was static, with two intentional changes:
 *
 * - `script-src` gains a fresh nonce every request. A bare `script-src 'self'`
 *   blocks Next.js's inline bootstrap/RSC scripts, so the page never hydrates
 *   in production. Next.js reads the nonce out of the request's
 *   `Content-Security-Policy` header while rendering and tags every inline
 *   script it emits with it, so no `'unsafe-inline'` is needed.
 * - `form-action` also allows the Google OAuth authorization endpoint. The
 *   "Continue with Google" flow is a plain form whose 303 result navigates to
 *   `https://accounts.google.com`; `form-action 'self'` blocked that
 *   navigation before any request was sent.
 *
 * The nonce must be served to both consumers: the request header for Next.js's
 * renderer and the response header for the browser that enforces the policy.
 * Production-only, matching the previous static setup.
 */
const cspDirectives = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://lh3.googleusercontent.com https://*.googleusercontent.com",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self' https://accounts.google.com",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
];

const buildCsp = (nonce: string): string =>
  [`script-src 'self' 'nonce-${nonce}'`, ...cspDirectives].join('; ');

/**
 * Tags every non-asset response with `x-request-id` and, in production, wraps
 * the response in a nonce-based Content-Security-Policy.
 *
 * The proxy is the one place that sees every request, so it is where the trace
 * id is minted (or the inbound id, for propagating a trace across services)
 * before the route handler, Server Action or page response is produced.
 * Whatever path a request takes, its logs carry the same id.
 */
export const proxy = (request: NextRequest): NextResponse => {
  if (!isProduction) {
    const response = NextResponse.next();
    response.headers.set(REQUEST_ID_HEADER, readRequestId(request.headers));
    return response;
  }

  const nonce = globalThis.crypto.randomUUID();
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(REQUEST_ID_HEADER, readRequestId(request.headers));
  response.headers.set('Content-Security-Policy', csp);

  return response;
};

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
