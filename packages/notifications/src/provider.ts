import { httpUrlSchema } from '@space/validation';
import { z } from 'zod';

/**
 * Email provider abstraction.
 *
 * Everything the delivery worker knows about email is this interface: a
 * synchronous `send` that returns a structured result. Retries, idempotency and
 * attempts are the worker's job; the provider just transports.
 *
 * The default implementation talks to AgentMail. It is provider-dependent and
 * deliberately not exercised locally — unit tests use a fake so the worker's
 * retry/outcome logic is verified without network access. CI exercises the
 * real contract.
 */

export type ProviderFailureKind = 'transient' | 'permanent';

export interface ProviderFailure {
  kind: ProviderFailureKind;
  code: string;
  message: string;
}

export type EmailSendResult =
  { ok: true; providerMessageId: string } | { ok: false; failure: ProviderFailure };

export interface EmailSendRequest {
  to: string;
  subject: string;
  html: string;
  /** Caller-provided reference used for outbound provider tracking/debugging. */
  providerReference: string;
}

export interface EmailProvider {
  readonly name: string;
  send(request: EmailSendRequest): Promise<EmailSendResult>;
}

// ---------------------------------------------------------------------------
// HTTP failure classification.
// ---------------------------------------------------------------------------

interface ProviderHttpError {
  status: number;
  body?: unknown;
}

const readMessage = (body: unknown): string => {
  if (typeof body === 'object' && body !== null) {
    const { error, message } = body as { error?: unknown; message?: unknown };
    if (typeof message === 'string') {
      return message;
    }
    if (typeof error === 'string') {
      return error;
    }
    if (typeof error === 'object' && error !== null) {
      return readMessage(error);
    }
  }
  return 'Unexpected provider response.';
};

/** Maps HTTP statuses to transient (retry) vs permanent (fail-fast) outcomes. */
export const classifyProviderHttpError = ({ status, body }: ProviderHttpError): ProviderFailure => {
  const message = readMessage(body);

  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { kind: 'transient', code: `http-${status}`, message };
  }
  if (status === 401 || status === 403) {
    return { kind: 'permanent', code: `http-${status}`, message: `${message} (auth)` };
  }
  return { kind: 'permanent', code: `http-${status}`, message };
};

// ---------------------------------------------------------------------------
// AgentMail provider.
// ---------------------------------------------------------------------------

const providerReferenceSchema = z.string().min(1).max(120);

interface AgentMailClientOptions {
  baseUrl: string;
  token: string;
  /** For tests: inject a fetch. Defaults to the platform fetch. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const messageResponseSchema = z.object({
  message: z.object({ id: z.string().min(1) }).optional(),
});

/**
 * AgentMail API client (unstable, cloud-defined surface).
 *
 * POST `<baseUrl>/v1/messages` with a bearer token. This contract is pinned to
 * AgentMail's current API; it lives behind {@link EmailProvider} so provider
 * changes never leak into worker logic.
 */
export class AgentMailProvider implements EmailProvider {
  readonly name = 'agentmail';

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AgentMailClientOptions) {
    this.baseUrl = httpUrlSchema.parse(options.baseUrl).replace(/\/+$/, '');
    this.token = options.token;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    const reference = providerReferenceSchema.parse(request.providerReference);

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
          'x-space-reference': reference,
        },
        body: JSON.stringify({ to: request.to, subject: request.subject, html: request.html }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : 'Network failure.';
      return {
        ok: false,
        failure: { kind: 'transient', code: 'network', message: cause },
      };
    }

    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      return { ok: false, failure: classifyProviderHttpError({ status: response.status, body }) };
    }

    const parsed = messageResponseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      return {
        ok: false,
        failure: {
          kind: 'permanent',
          code: 'provider-response',
          message: 'Provider acknowledged the message but returned no id.',
        },
      };
    }

    const messageId = parsed.data.message?.id ?? '';
    if (messageId.length === 0) {
      return {
        ok: false,
        failure: {
          kind: 'permanent',
          code: 'provider-response',
          message: 'Provider acknowledged the message but returned no id.',
        },
      };
    }

    return { ok: true, providerMessageId: messageId };
  }
}

export interface EmailProviderConfig {
  baseUrl: string;
  token: string;
}

/** Factory: null when AgentMail isn't configured, so delivery can stay disabled. */
export const createEmailProvider = (config?: EmailProviderConfig): EmailProvider | null => {
  if (config === undefined || config.token.length === 0) {
    return null;
  }
  return new AgentMailProvider(config);
};
