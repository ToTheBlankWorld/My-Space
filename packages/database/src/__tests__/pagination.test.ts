import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type Page } from '@space/types';
import { describe, expect, it } from 'vitest';

import { cursorQuery, resolveLimit, toPage } from '../pagination';

interface Row {
  id: string;
}

const rows = (count: number, offset = 0): Row[] =>
  Array.from({ length: count }, (_unused, index) => ({ id: `row-${index + offset}` }));

describe('resolveLimit', () => {
  it('falls back to the default when no limit is given', () => {
    expect(resolveLimit()).toBe(DEFAULT_PAGE_SIZE);
    expect(resolveLimit(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
    expect(resolveLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PAGE_SIZE);
  });

  it('caps a caller that asks for the whole table', () => {
    expect(resolveLimit(1_000_000)).toBe(MAX_PAGE_SIZE);
  });

  it('never returns less than one row', () => {
    expect(resolveLimit(0)).toBe(1);
    expect(resolveLimit(-10)).toBe(1);
  });

  it('truncates a fractional limit', () => {
    expect(resolveLimit(10.9)).toBe(10);
  });
});

describe('cursorQuery', () => {
  it('over-fetches by one so the next page can be detected without a count query', () => {
    expect(cursorQuery({ limit: 10 })).toEqual({ take: 11 });
  });

  it('steps past the cursor row itself', () => {
    expect(cursorQuery({ limit: 5, cursor: 'row-4' })).toEqual({
      take: 6,
      skip: 1,
      cursor: { id: 'row-4' },
    });
  });

  it('treats a null cursor as the first page', () => {
    expect(cursorQuery({ limit: 5, cursor: null })).toEqual({ take: 6 });
  });
});

describe('toPage', () => {
  it('reports no next cursor when the last page is short', () => {
    expect(toPage(rows(3), { limit: 10 })).toEqual({
      items: rows(3),
      nextCursor: null,
    });
  });

  it('reports no next cursor when the page is exactly full', () => {
    // Ten rows for a limit of ten means the over-fetched eleventh was absent.
    const page = toPage(rows(10), { limit: 10 });

    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).toBeNull();
  });

  it('trims the over-fetched row and returns the last kept id as the cursor', () => {
    const page = toPage(rows(11), { limit: 10 });

    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).toBe('row-9');
  });

  it('applies the cap when the caller asked for more than the maximum', () => {
    const page = toPage(rows(MAX_PAGE_SIZE + 1), { limit: 10_000 });

    expect(page.items).toHaveLength(MAX_PAGE_SIZE);
    expect(page.nextCursor).toBe(`row-${MAX_PAGE_SIZE - 1}`);
  });

  it('walks a list to exhaustion without repeating or skipping a row', () => {
    const all = rows(25);
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 10; guard += 1) {
      const start = cursor === null ? 0 : all.findIndex((row) => row.id === cursor) + 1;
      const slice = all.slice(start, start + 11);
      const page: Page<Row> = toPage(slice, { limit: 10, cursor });

      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;

      if (cursor === null) {
        break;
      }
    }

    expect(seen).toEqual(all.map((row) => row.id));
    expect(new Set(seen).size).toBe(all.length);
  });
});
