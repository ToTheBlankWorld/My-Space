import { httpUrlSchema } from '@space/validation';
import { z } from 'zod';

import { assertServerRuntime, defineEnv, type EnvSource } from './define-env';
import { nodeEnvSchema } from './node-env';

const SCOPE = '@space/web (server)';

/**
 * Server-side environment for the Next.js application.
 *
 * Only variables that the current stage actually consumes are declared. Future
 * secrets (`DATABASE_URL`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, ...) are
 * added here — never to {@link webClientEnvSchema} — so that a secret can only
 * reach the browser through a deliberate, reviewable change.
 */
export const webServerEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  /** Public origin of the deployed application; used for absolute URLs and metadata. */
  APP_URL: httpUrlSchema.default('http://localhost:3000'),
});

export type WebServerEnv = z.output<typeof webServerEnvSchema>;

/**
 * Client-side environment for the Next.js application.
 *
 * Every value here is inlined into the browser bundle and is therefore public.
 * Keys must be prefixed with `NEXT_PUBLIC_` and must never hold a credential.
 * Next.js only inlines statically referenced `process.env.NEXT_PUBLIC_*` reads,
 * so entries are listed explicitly rather than spread from `process.env`.
 */
export const webClientEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
});

export type WebClientEnv = z.output<typeof webClientEnvSchema>;

/** Loads and validates the server environment. Throws on the first bad value. */
export const loadWebServerEnv = (source?: EnvSource): Readonly<WebServerEnv> => {
  assertServerRuntime(SCOPE);
  return defineEnv(SCOPE, webServerEnvSchema, source);
};

/** Loads and validates the public environment. Safe to evaluate in the browser. */
export const loadWebClientEnv = (source?: EnvSource): Readonly<WebClientEnv> =>
  defineEnv('@space/web (client)', webClientEnvSchema, source);
