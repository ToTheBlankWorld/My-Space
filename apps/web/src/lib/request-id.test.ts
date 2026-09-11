import { describe, expect, it } from 'vitest';

import { createRequestId, readRequestId, REQUEST_ID_HEADER } from './request-id';

describe('createRequestId', () => {
  it('produces a UUID-format id and a fresh one each call', () => {
    const first = createRequestId();
    const second = createRequestId();

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });
});

describe('readRequestId', () => {
  it('generates an id when no header is present', () => {
    const id = readRequestId(new Headers());

    expect(id).toMatch(/^[0-9a-f]{8}-/);
  });

  it('propagates a well-formed inbound id', () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: 'edge-42.abc' });

    expect(readRequestId(headers)).toBe('edge-42.abc');
  });

  it('ignores an over-long inbound id', () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: 'a'.repeat(300) });

    expect(readRequestId(headers)).toMatch(/^[0-9a-f]{8}-/);
  });

  it('ignores an id containing characters that do not belong in a log line', () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: 'edge 42' });

    expect(readRequestId(headers)).toMatch(/^[0-9a-f]{8}-/);
  });

  it('trims surrounding whitespace before accepting', () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: '  edge-42.abc  ' });

    expect(readRequestId(headers)).toBe('edge-42.abc');
  });
});
