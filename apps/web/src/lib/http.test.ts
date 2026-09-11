import { describe, expect, it } from 'vitest';

import { classifyOrigin, jsonError, readJsonBody } from './http';

describe('readJsonBody', () => {
  it('returns the parsed body when the request is valid JSON', async () => {
    const result = await readJsonBody({
      json: () => Promise.resolve({ date: '2026-01-01' }),
    });

    expect(result).toEqual({ ok: true, body: { date: '2026-01-01' } });
  });

  it('returns not-ok when the body is invalid JSON', async () => {
    const result = await readJsonBody({
      json: () => {
        throw new SyntaxError('Unexpected token');
      },
    });

    expect(result).toEqual({ ok: false });
  });

  it('returns not-ok when the body throws a non-parse error', async () => {
    const result = await readJsonBody({
      json: () => {
        throw new Error('body stream exhausted');
      },
    });

    expect(result).toEqual({ ok: false });
  });
});

describe('jsonError', () => {
  it('shapes an error response', async () => {
    const response = jsonError('Authentication required.', 401);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Authentication required.' });
  });
});

describe('classifyOrigin', () => {
  const at = (origin: string | null, url: string) => ({
    url,
    headers: { get: () => origin },
  });

  it('returns same-origin when the origin matches the request URL', () => {
    expect(classifyOrigin(at('https://app.example.com', 'https://app.example.com/api/plan'))).toBe(
      'same-origin',
    );
  });

  it('returns cross-origin when the origin differs from the request URL', () => {
    expect(classifyOrigin(at('https://evil.example.net', 'https://app.example.com/api/plan'))).toBe(
      'cross-origin',
    );
  });

  it('returns cross-origin for a sandboxed null origin', () => {
    expect(classifyOrigin(at('null', 'https://app.example.com/api/plan'))).toBe('cross-origin');
  });

  it('returns absent when no origin header is sent', () => {
    expect(classifyOrigin(at(null, 'https://app.example.com/api/plan'))).toBe('absent');
  });

  it('returns cross-origin when the referer-style origin is malformed', () => {
    expect(classifyOrigin(at('not a url', 'https://app.example.com/api/plan'))).toBe(
      'cross-origin',
    );
  });
});
