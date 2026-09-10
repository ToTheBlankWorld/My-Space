import { describe, expect, it } from 'vitest';

import { AgentMailProvider, classifyProviderHttpError, createEmailProvider } from './provider';

const BASE = 'https://agentmail.example.com';
const TOKEN = 'secret-token';

const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('classifyProviderHttpError', () => {
  it('maps 429 and 5xx to transient', () => {
    expect(classifyProviderHttpError({ status: 429, body: {} }).kind).toBe('transient');
    expect(classifyProviderHttpError({ status: 500, body: {} }).kind).toBe('transient');
    expect(classifyProviderHttpError({ status: 503, body: { message: 'down' } }).kind).toBe(
      'transient',
    );
  });

  it('maps 4xx (except 401/403) to permanent', () => {
    expect(classifyProviderHttpError({ status: 400, body: { error: 'bad to' } })).toEqual({
      kind: 'permanent',
      code: 'http-400',
      message: 'bad to',
    });
  });

  it('marks 401/403 as permanent auth failures', () => {
    const failure = classifyProviderHttpError({ status: 403, body: { message: 'forbidden' } });
    expect(failure.kind).toBe('permanent');
    expect(failure.message).toContain('(auth)');
  });

  it('reads nested error messages', () => {
    const failure = classifyProviderHttpError({
      status: 429,
      body: { error: { message: 'slow down' } },
    });
    expect(failure.message).toBe('slow down');
  });
});

const providerFor = (fetchFn: typeof fetch) =>
  new AgentMailProvider({ baseUrl: BASE, token: TOKEN, fetchFn });

describe('AgentMailProvider', () => {
  it('sends a message and returns the provider id', async () => {
    let sent: unknown = null;
    let url = '';
    const provider = providerFor((input: string | URL | Request, init?: RequestInit) => {
      url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
      sent = init ?? null;
      return Promise.resolve(response(200, { message: { id: 'msg-1' } }));
    });

    const result = await provider.send({
      to: 'user@example.com',
      subject: 'Hello',
      html: '<p>hi</p>',
      providerReference: 'ntf-1',
    });

    expect(result).toEqual({ ok: true, providerMessageId: 'msg-1' });
    expect(url).toBe(`${BASE}/v1/messages`);
    const request = sent as {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } | null;
    expect(request?.method).toBe('POST');
    expect(request?.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(request?.body))).toMatchObject({
      to: 'user@example.com',
      subject: 'Hello',
    });
  });

  it('classifies a 5xx as a transient failure', async () => {
    const provider = providerFor(() => Promise.resolve(response(503, { message: 'unavailable' })));
    const result = await provider.send({
      to: 'u@e.com',
      subject: 's',
      html: 'h',
      providerReference: 'n1',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('transient');
      expect(result.failure.code).toBe('http-503');
    }
  });

  it('classifies a 403 as a permanent auth failure', async () => {
    const provider = providerFor(() => Promise.resolve(response(403, { message: 'nope' })));
    const result = await provider.send({
      to: 'u@e.com',
      subject: 's',
      html: 'h',
      providerReference: 'n2',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('permanent');
      expect(result.failure.message).toContain('(auth)');
    }
  });

  it('a network failure is transient and never throws', async () => {
    const provider = providerFor(() => Promise.reject(new Error('ECONNREFUSED')));
    const result = await provider.send({
      to: 'u@e.com',
      subject: 's',
      html: 'h',
      providerReference: 'n3',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('transient');
      expect(result.failure.code).toBe('network');
    }
  });

  it('an ok response without a message id is a permanent provider-response failure', async () => {
    const provider = providerFor(() => Promise.resolve(response(200, { hello: 'world' })));
    const result = await provider.send({
      to: 'u@e.com',
      subject: 's',
      html: 'h',
      providerReference: 'n4',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('provider-response');
      expect(result.failure.kind).toBe('permanent');
    }
  });
});

describe('createEmailProvider', () => {
  it('returns null when no token is configured', () => {
    expect(createEmailProvider({ baseUrl: BASE, token: '' })).toBeNull();
    expect(createEmailProvider()).toBeNull();
  });

  it('builds a provider when configured', () => {
    const provider = createEmailProvider({ baseUrl: BASE, token: TOKEN });
    expect(provider?.name).toBe('agentmail');
  });
});
