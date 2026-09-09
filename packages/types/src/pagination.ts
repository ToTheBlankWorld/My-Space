/**
 * Cursor pagination contract.
 *
 * Every list that can grow without bound returns a `Page`. Offset pagination is
 * deliberately avoided: an event log or a task history is append-heavy, and
 * `OFFSET n` both skips rows that shift under concurrent writes and degrades
 * linearly as `n` grows.
 */
export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque cursor for the next page, or `null` when the list is exhausted. */
  readonly nextCursor: string | null;
}

export interface PageRequest {
  /** Maximum number of rows to return. Callers must stay within a repository's cap. */
  readonly limit?: number;
  /** Cursor returned by the previous page. */
  readonly cursor?: string | null;
}

/** Default page size used when a caller does not ask for one. */
export const DEFAULT_PAGE_SIZE = 50;

/** Hard ceiling on any single page, so one request cannot read a whole history. */
export const MAX_PAGE_SIZE = 200;
