import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type Page, type PageRequest } from '@space/types';

/**
 * Cursor pagination helpers.
 *
 * Every list in this package is bounded. An unbounded `findMany` is the single
 * easiest way to turn one user's long history into a slow query and a large
 * response, so the cap is applied here rather than trusted to each call site.
 */

export interface CursorQuery {
  take: number;
  skip?: number;
  cursor?: { id: string };
}

/** Clamps a requested page size into `[1, MAX_PAGE_SIZE]`. */
export const resolveLimit = (limit?: number): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_PAGE_SIZE;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
};

/**
 * Builds the Prisma arguments for one page.
 *
 * One extra row is requested so the caller can tell whether another page exists
 * without running a second `count` query.
 */
export const cursorQuery = (request: PageRequest = {}): CursorQuery => {
  const take = resolveLimit(request.limit) + 1;

  if (!request.cursor) {
    return { take };
  }

  // `skip: 1` steps past the cursor row itself, which was already returned.
  return { take, skip: 1, cursor: { id: request.cursor } };
};

/** Splits an over-fetched row set into a page and its next cursor. */
export const toPage = <T extends { id: string }>(rows: T[], request: PageRequest = {}): Page<T> => {
  const limit = resolveLimit(request.limit);

  if (rows.length <= limit) {
    return { items: rows, nextCursor: null };
  }

  const items = rows.slice(0, limit);
  return { items, nextCursor: items[items.length - 1]?.id ?? null };
};
