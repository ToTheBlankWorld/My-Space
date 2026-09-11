/**
 * Pure HTTP helpers for route handlers.
 *
 * Kept dependency-free (no `next/server`, no workspace packages) so every
 * function is unit-testable in the web app's Vitest setup without aliases.
 * Framework concerns (`NextResponse`, session resolution) live one layer up in
 * `server/api.ts`.
 */

export interface JsonErrorBody {
  error: string;
}

/** A JSON 4xx/5xx body in the shape the client already understands. */
export const jsonError = (message: string, status: number): Response =>
  Response.json({ error: message }, { status });

export type ReadJsonResult = { ok: true; body: unknown } | { ok: false };

/**
 * Parses a request body as JSON without throwing.
 *
 * Route handlers need three outcomes: a valid object, an invalid body (400),
 * or success. This collapses those into one discriminated union and never
 * throws, so a malformed body cannot escape as a 500.
 */
export const readJsonBody = async (request: {
  json: () => Promise<unknown>;
}): Promise<ReadJsonResult> => {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
};

export type OriginClass = 'same-origin' | 'cross-origin' | 'absent';

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * Classifies a request's `Origin` header against the request URL's own origin.
 *
 * - `same-origin`: the browser asserts it came from this app's origin.
 * - `cross-origin`: an `Origin` was sent but does not match — a CSRF-shaped
 *   request from another site (or a sandboxed `Origin: null`).
 * - `absent`: no `Origin` header (curl, health checks, legacy clients). Not
 *   proof of anything, so mutations treat it separately.
 */
export const classifyOrigin = (request: {
  url: string;
  headers: { get(name: string): string | null };
}): OriginClass => {
  const origin = request.headers.get('origin');
  if (origin === null || origin === '') {
    return 'absent';
  }
  return originOf(request.url) === origin ? 'same-origin' : 'cross-origin';
};
