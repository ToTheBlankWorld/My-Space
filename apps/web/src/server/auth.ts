import 'server-only';

import { createAuth, createAuthService, type AuthService } from '@space/auth';
import { createLogger, type Logger } from '@space/logger';

import { clock } from './clock';
import { getDatabase } from './database';

/**
 * The web application's authentication composition root.
 *
 * Built once per process and cached on `globalThis` for the same reason as the
 * database client: Next.js re-evaluates modules on every hot reload, and a fresh
 * authentication server per edit would mean a fresh connection pool per edit.
 *
 * `server-only` is the enforcement: pulling this module into a client bundle
 * fails the build rather than shipping `AUTH_SECRET` to a browser.
 *
 * Construction is lazy. Importing this file does not read a secret, so the
 * application still builds and renders its public pages on a machine that holds
 * no credentials.
 */

const cache = globalThis as typeof globalThis & {
  __spaceAuthService?: AuthService;
  __spaceAuthLogger?: Logger;
};

const getLogger = (): Logger => {
  cache.__spaceAuthLogger ??= createLogger({
    name: 'space-web',
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  });

  return cache.__spaceAuthLogger;
};

export const getAuthService = (): AuthService => {
  if (!cache.__spaceAuthService) {
    const database = getDatabase();
    const logger = getLogger();

    cache.__spaceAuthService = createAuthService({
      auth: createAuth({ database, logger }),
      database,
      logger,
      clock,
    });
  }

  return cache.__spaceAuthService;
};
