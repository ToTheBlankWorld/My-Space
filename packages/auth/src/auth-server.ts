import { loadAuthEnv, type AuthEnv } from '@space/config/auth';
import type { DatabaseClient } from '@space/database';
import type { Logger } from '@space/logger';
import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';

import { createKeyring, type Keyring } from './crypto/keyring';
import { createEncryptingPrismaAdapter } from './encrypting-adapter';

/**
 * The authentication server.
 *
 * `better-auth` was chosen over the alternatives because it is the only mature,
 * actively released option that targets this exact stack — Next.js 16 App
 * Router, Prisma 7, React 19, zod 4 — with first-class server-side database
 * sessions. Auth.js's stable line is still v4 (Pages Router era) and its v5 has
 * been in beta for years; hand-rolling OAuth would mean owning state, PKCE,
 * nonce and session rotation ourselves for no benefit.
 *
 * Everything provider-specific lives here. The rest of the application depends
 * on `getSession` / `requireUser` and never imports `better-auth` directly.
 */

export interface CreateAuthOptions {
  database: DatabaseClient;
  logger: Logger;
  /** Overrides the process environment. Tests pass an explicit map. */
  env?: Readonly<AuthEnv>;
}

/**
 * Scopes requested at sign-in.
 *
 * Identity only. Calendar scopes are deliberately absent: asking for calendar
 * access on the first screen, before the product has explained why, is how
 * consent rates collapse. Stage 4 requests them incrementally, which is also why
 * `Account.scope` is persisted.
 */
const GOOGLE_SCOPES = ['openid', 'email', 'profile'] as const;

/**
 * Builds a configured authentication server.
 *
 * The environment is read here rather than at module load, so importing this
 * module during a build — or in a test that never signs anyone in — does not
 * require a secret to exist.
 */
export const createAuth = ({ database, logger, env = loadAuthEnv() }: CreateAuthOptions) => {
  const keyring: Keyring = createKeyring({
    activeKey: env.OAUTH_ENCRYPTION_KEY,
    previousKeys: env.OAUTH_ENCRYPTION_PREVIOUS_KEYS,
  });

  const authLogger = logger.child({ component: 'auth' });

  return betterAuth({
    appName: 'Space',
    baseURL: env.APP_URL,
    basePath: '/api/auth',
    secret: env.AUTH_SECRET,

    // Credentials are encrypted at the storage boundary; see `encrypting-adapter`.
    database: createEncryptingPrismaAdapter(database, keyring),

    // No usage data leaves this deployment.
    telemetry: { enabled: false },

    /**
     * Only origins we control may receive a post-sign-in redirect.
     *
     * This is the open-redirect defence: a `callbackURL` pointing anywhere else
     * is rejected by the library rather than followed.
     */
    trustedOrigins: [env.APP_URL],

    /**
     * Only on for the deterministic end-to-end route.
     *
     * The environment schema refuses `E2E_AUTH_ENABLED` in production, so a
     * test deployment can hold the flag on and a production one cannot. See
     * `e2e.ts` for why a test-only sign-in exists at all.
     */
    emailAndPassword: { enabled: env.E2E_AUTH_ENABLED },

    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        scope: [...GOOGLE_SCOPES],
        /**
         * Ask Google for a refresh token.
         *
         * Needed for Stage 4, which will call the Calendar API on the user's
         * behalf while they are not present. Google only issues one with
         * `access_type=offline`, and only on the first consent unless prompted.
         */
        accessType: 'offline',
        prompt: 'consent',
      },
    },

    account: {
      /**
       * Encryption is ours, not the library's.
       *
       * The built-in option derives its key from `AUTH_SECRET` and has no key id
       * or version, so rotating the session secret would strand every stored
       * credential. See `docs/authentication.md`.
       */
      encryptOAuthTokens: false,
      accountLinking: {
        /**
         * Link a new provider to an existing account only when the provider has
         * verified the address itself.
         *
         * Without this, anyone able to create an account at a provider using a
         * victim's unverified address could take over the Space account.
         */
        enabled: true,
        trustedProviders: ['google'],
      },
    },

    user: {
      // The application column is `imageUrl`; the library calls it `image`.
      fields: { image: 'imageUrl' },
    },

    session: {
      expiresIn: env.AUTH_SESSION_MAX_AGE_SECONDS,
      updateAge: env.AUTH_SESSION_UPDATE_AGE_SECONDS,
      /**
       * Sessions are rows, not self-contained tokens.
       *
       * The cost is one indexed lookup per request. The benefit is that
       * revocation is immediate: deleting the row ends the session, which a JWT
       * cannot offer without a second revocation list.
       */
      storeSessionInDatabase: true,
    },

    advanced: {
      /**
       * `__Secure-` prefix and `secure` in production.
       *
       * `SameSite=Lax` is required rather than `Strict`: the OAuth callback is a
       * cross-site top-level navigation back from Google, and `Strict` would
       * withhold the state cookie and break every sign-in.
       */
      useSecureCookies: env.NODE_ENV === 'production',
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      },
      cookiePrefix: 'space',
    },

    /**
     * `nextCookies` lets a Server Action set the session cookie.
     *
     * Without it, signing in from an action would create the session row and
     * then drop the cookie, leaving the user anonymous on the next request.
     */
    plugins: [nextCookies()],

    databaseHooks: {
      user: {
        create: {
          after: (user) => {
            // No email, no name, no picture: an account identifier is enough to
            // correlate, and the rest is personal data that does not belong in
            // an operational log.
            authLogger.info({ userId: user.id }, 'account created');
            return Promise.resolve();
          },
        },
      },
      session: {
        create: {
          before: (session) => {
            authLogger.info(
              { userId: session.userId, expiresAt: session.expiresAt.toISOString() },
              'session created',
            );
            return Promise.resolve();
          },
        },
      },
    },

    onAPIError: {
      onError: (error) => {
        // `error` here can carry request context. Only its shape is logged: an
        // OAuth error body may quote the authorization code back at us.
        const name = error instanceof Error ? error.name : 'UnknownError';
        const message = error instanceof Error ? error.message : 'unknown authentication error';
        authLogger.warn({ error: name, message }, 'authentication request failed');
      },
    },
  });
};

/**
 * The configured server.
 *
 * Inferred rather than annotated as `Auth<BetterAuthOptions>`: better-auth's
 * type is generic over the exact options object, and widening it discards the
 * endpoint types the route handler relies on.
 */
export type SpaceAuth = ReturnType<typeof createAuth>;
