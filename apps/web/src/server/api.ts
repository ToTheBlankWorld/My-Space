import 'server-only';

import type { SessionContext } from '@space/auth';
import { createLogger, type Logger } from '@space/logger';
import { systemClock } from '@space/time';

import { classifyOrigin, jsonError } from '@/lib/http';
import { readRequestId, REQUEST_ID_HEADER } from '@/lib/request-id';
import { API_RATE_LIMITS, WebRateLimiter, type ApiRateLimitScope } from './rate-limits';
import { getOptionalUser } from './session';

/**
 * The JSON API surface's server-side envelope.
 *
 * Route handlers are thin: resolve the session, verify the request is
 * same-origin for mutations, spend a rate-limit budget, do the work. This
 * module supplies the shared pieces and the error envelope, so every endpoint
 * fails the same way: JSON, never a redirect, and never a thrown stack trace.
 *
 * The in-memory limiters are per-process state. That is the deliberate trade —
 * the auth flow already has the same shape — and it is documented where the
 * limiter lives. A shared limiter is a separate concern.
 */

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Resolves the session or throws a JSON 401.
 *
 * Pages redirect to the login screen; a `fetch` client would silently follow a
 * 302 and parse the login HTML as JSON. These API routes must never redirect.
 */
export const requireApiUser = async (): Promise<SessionContext> => {
  const context = await getOptionalUser();

  if (!context) {
    throw new ApiError(401, 'Authentication required.');
  }

  return context;
};

/**
 * Refuses mutations whose `Origin` is a different site.
 *
 * Combined with the JSON-only body parsing and the SameSite session cookie,
 * this closes the cross-site request path: a cross-site form cannot send JSON
 * (its encoding is always rejected), and a cross-site script cannot send the
 * matching Origin header.
 */
export const requireSameOrigin = (request: Request, mutation = true): void => {
  if (!mutation) {
    return;
  }

  if (classifyOrigin(request) === 'cross-origin') {
    throw new ApiError(403, 'Cross-origin requests are not allowed.');
  }
};

const limiters = new Map<ApiRateLimitScope, WebRateLimiter>();

const limiterFor = (scope: ApiRateLimitScope): WebRateLimiter => {
  let limiter = limiters.get(scope);
  if (!limiter) {
    limiter = new WebRateLimiter(API_RATE_LIMITS[scope], systemClock);
    limiters.set(scope, limiter);
  }
  return limiter;
};

/**
 * Spends one unit of the given scope's budget for `key`.
 *
 * `key` must be derived from server-side facts (a session user id), never raw
 * client input, so one caller cannot exhaust another's budget.
 */
export const spendRateLimit = (scope: ApiRateLimitScope, key: string): void => {
  const decision = limiterFor(scope).consume(`${scope}:${key}`);

  if (!decision.allowed) {
    throw new ApiError(429, 'Too many requests. Try again later.');
  }
};

const isNextControlSignal = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const digest = (error as Error & { digest?: unknown }).digest;
  return (
    typeof digest === 'string' &&
    (digest.startsWith('NEXT_REDIRECT') || digest.startsWith('NEXT_NOT_FOUND'))
  );
};

const cache = globalThis as typeof globalThis & { __spaceApiLogger?: Logger };

export const getApiLogger = (): Logger => {
  cache.__spaceApiLogger ??= createLogger({
    name: 'space-api',
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  });
  return cache.__spaceApiLogger;
};

export type ApiRouteHandler = (request: Request) => Promise<Response> | Response;

/**
 * Wraps a route handler so thrown failures become JSON responses.
 *
 * `ApiError` maps to its status; Next's redirect/not-found control signals pass
 * through unchanged; anything else is logged and answered with a generic 500 —
 * the internals are never echoed to the client.
 */
export const withApi = (handler: ApiRouteHandler): ApiRouteHandler => {
  return async (request: Request): Promise<Response> => {
    try {
      return await handler(request);
    } catch (error) {
      const requestId = readRequestId(request.headers);

      if (error instanceof ApiError) {
        const response = jsonError(error.message, error.status);
        response.headers.set(REQUEST_ID_HEADER, requestId);
        return response;
      }

      if (isNextControlSignal(error)) {
        throw error;
      }

      getApiLogger().error({ err: error, requestId }, 'unhandled API route error');
      const response = jsonError('An unexpected error occurred.', 500);
      response.headers.set(REQUEST_ID_HEADER, requestId);
      return response;
    }
  };
};
