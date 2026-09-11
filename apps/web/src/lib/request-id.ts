/**
 * One id per request, so logs across middleware, route handlers, jobs and
 * provider calls can be stitched back together.
 *
 * Purely functional and framework-free so it can be unit-tested: the id is
 * generated from the Web Crypto API (available in both the Node and Edge
 * runtimes, and in Vitest's node environment) and an inbound `x-request-id`
 * is only honoured when it cannot corrupt a log line.
 */

export const REQUEST_ID_HEADER = 'x-request-id';

/** A fresh, unguessable id for one request's trail. */
export const createRequestId = (): string => globalThis.crypto.randomUUID();

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Prefers an inbound `x-request-id` (for trace propagation) and falls back to
 * a fresh id otherwise.
 *
 * An attacker can send any value, but the only power this grants is choosing
 * an opaque string in the server's logs, so the checks are about staying safe
 * to store and print: bounded length, printable ASCII, no whitespace.
 */
export const readRequestId = (headers: Headers): string => {
  const existing = headers.get(REQUEST_ID_HEADER)?.trim() ?? '';

  if (
    existing.length > 0 &&
    existing.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(existing)
  ) {
    return existing;
  }

  return createRequestId();
};
