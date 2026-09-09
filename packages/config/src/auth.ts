import { booleanFromEnvSchema, httpUrlSchema, nonEmptyStringSchema } from '@space/validation';
import { z } from 'zod';

import { assertServerRuntime, defineEnv, type EnvSource } from './define-env';
import { nodeEnvSchema } from './node-env';

const SCOPE = '@space/auth';

/**
 * Authentication environment.
 *
 * Every value here is a secret or a security-relevant setting, so the schema
 * lives beside the other server-only environments and is loaded through the same
 * `defineEnv` path. None of these keys carries the `NEXT_PUBLIC_` prefix, and
 * none may ever be given one: that prefix inlines a value into the browser
 * bundle.
 *
 * Nothing is defaulted. A missing `AUTH_SECRET` or encryption key is a
 * misconfiguration that must stop the process, not something to paper over with
 * a generated value that changes on the next restart.
 */

/**
 * Minimum length for the session signing secret.
 *
 * 32 characters of a random secret is the point past which brute-forcing a
 * signature is not the weakest link.
 */
const MIN_SECRET_LENGTH = 32;

const secretSchema = nonEmptyStringSchema.min(MIN_SECRET_LENGTH, {
  message: `must be at least ${MIN_SECRET_LENGTH} characters; generate one with "openssl rand -base64 32"`,
});

/** `<keyId>:<base64 32-byte key>`; the key material itself is checked by the keyring. */
const encryptionKeySchema = nonEmptyStringSchema.regex(/^[a-z0-9][a-z0-9_-]{0,31}:.+$/, {
  message: 'must be formatted as "<keyId>:<base64 key>"',
});

export const authEnvSchema = z
  .object({
    NODE_ENV: nodeEnvSchema,

    /**
     * Public origin of the application.
     *
     * Used to build the OAuth redirect URI and to bound redirects after
     * sign-in. It must match `APP_URL` in the web application exactly, or Google
     * will reject the callback.
     */
    APP_URL: httpUrlSchema.default('http://localhost:3000'),

    /** Signs session cookies and OAuth state. Rotating it invalidates every session. */
    AUTH_SECRET: secretSchema,

    GOOGLE_CLIENT_ID: nonEmptyStringSchema,
    GOOGLE_CLIENT_SECRET: nonEmptyStringSchema,

    /**
     * Active key for credential encryption.
     *
     * Deliberately separate from `AUTH_SECRET`: sessions and stored OAuth
     * credentials have different lifetimes and different blast radii, so
     * rotating one must not invalidate the other.
     */
    OAUTH_ENCRYPTION_KEY: encryptionKeySchema,

    /** Retired keys, decrypt-only, comma separated. Present only during a rotation. */
    OAUTH_ENCRYPTION_PREVIOUS_KEYS: z.string().optional(),

    /** Session lifetime. Default 30 days. */
    AUTH_SESSION_MAX_AGE_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(60 * 60 * 24 * 90)
      .default(60 * 60 * 24 * 30),

    /**
     * How often an active session's expiry is extended.
     *
     * Rolling the expiry on every request would write to the database on every
     * request; once a day is enough to keep an active user signed in.
     */
    AUTH_SESSION_UPDATE_AGE_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(60 * 60 * 24 * 30)
      .default(60 * 60 * 24),

    /**
     * Enables the deterministic sign-in route used by end-to-end tests.
     *
     * Guarded three ways: this flag, a shared secret, and a hard refusal to
     * initialise when `NODE_ENV` is `production`. See `assertE2EAuthAllowed`.
     */
    E2E_AUTH_ENABLED: booleanFromEnvSchema.default(false),
    E2E_AUTH_SECRET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.E2E_AUTH_ENABLED && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['E2E_AUTH_ENABLED'],
        message: 'the end-to-end sign-in route can never be enabled in production',
      });
    }

    if (env.E2E_AUTH_ENABLED && (env.E2E_AUTH_SECRET ?? '').length < MIN_SECRET_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['E2E_AUTH_SECRET'],
        message: `must be at least ${MIN_SECRET_LENGTH} characters when E2E_AUTH_ENABLED is set`,
      });
    }
  });

export type AuthEnv = z.output<typeof authEnvSchema>;

/**
 * Loads and validates the authentication environment.
 *
 * Called lazily, on first use, rather than at module load: the web application
 * must still build and render its public pages on a machine that holds no
 * secrets.
 */
export const loadAuthEnv = (source?: EnvSource): Readonly<AuthEnv> => {
  assertServerRuntime(SCOPE);
  return defineEnv(SCOPE, authEnvSchema, source);
};
