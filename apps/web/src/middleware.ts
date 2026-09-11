import { NextResponse, type NextRequest } from 'next/server';

import { readRequestId, REQUEST_ID_HEADER } from '@/lib/request-id';

/**
 * Tags every non-asset response with `x-request-id`.
 *
 * Middleware is the one place that sees every request, so it is where the
 * trace id is minted (or the inbound id, for propagating a trace across
 * services) before the route handler, Server Action or page response is
 * produced. Whatever path a request takes, its logs carry the same id.
 */
export const middleware = (request: NextRequest): NextResponse => {
  const response = NextResponse.next();
  response.headers.set(REQUEST_ID_HEADER, readRequestId(request.headers));
  return response;
};

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
