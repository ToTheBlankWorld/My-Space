import 'server-only';

import { createKeyring, type Keyring } from '@space/auth';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  type GoogleOAuthConfig,
} from '@space/calendar';
import { loadAuthEnv, type AuthEnv } from '@space/config/auth';
import type { DatabaseClient } from '@space/database';
import { createLogger, type Logger } from '@space/logger';
import { randomBytes } from 'node:crypto';

import { getDatabase } from './database';

/**
 * The web application's calendar composition root.
 *
 * Resolves the Google OAuth config, the credential keyring and the auth
 * environment lazily and caches them on `globalThis`, following the same shape
 * as `./auth`. Importing this module never reads a secret; construction happens
 * on first calendar request, so a machine without the values still boots.
 *
 * Token encryption uses the same keyring as `@space/auth` but a distinct
 * purpose (`calendar.*`), so a calendar token can never authenticate as an
 * identity token, and vice versa.
 */

const cache = globalThis as typeof globalThis & {
  __spaceCalendarEnv?: AuthEnv;
  __spaceCalendarKeyring?: Keyring;
  __spaceCalendarLogger?: Logger;
};

const getEnv = (): AuthEnv => {
  if (!cache.__spaceCalendarEnv) {
    cache.__spaceCalendarEnv = loadAuthEnv();
  }
  return cache.__spaceCalendarEnv;
};

const getKeyring = (): Keyring => {
  if (!cache.__spaceCalendarKeyring) {
    const env = getEnv();
    cache.__spaceCalendarKeyring = createKeyring({
      activeKey: env.OAUTH_ENCRYPTION_KEY,
      previousKeys: env.OAUTH_ENCRYPTION_PREVIOUS_KEYS,
    });
  }
  return cache.__spaceCalendarKeyring;
};

export const getCalendarLogger = (): Logger => {
  cache.__spaceCalendarLogger ??= createLogger({
    name: 'space-calendar',
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  });
  return cache.__spaceCalendarLogger;
};

export const getGoogleOAuthConfig = (): GoogleOAuthConfig => {
  const env = getEnv();
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${env.APP_URL}/api/calendar/callback`,
  };
};

export const getCalendarKeyring = (): Keyring => getKeyring();

// Annotated rather than inferred: Prisma's client type references generated
// internals that a consuming package cannot name.
export const getCalendarDatabase = (): DatabaseClient => getDatabase();

/**
 * A fresh, unguessable anti-CSRF token for one consent flow.
 *
 * Bound into the OAuth `state` parameter and mirrored into a short-lived
 * HttpOnly cookie. The callback accepts the code only when the two match.
 */
export const createOAuthState = (): string => randomBytes(32).toString('base64url');

export { buildAuthorizationUrl, exchangeAuthorizationCode };
