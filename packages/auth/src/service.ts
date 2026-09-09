import type { DatabaseClient } from '@space/database';
import type { Logger } from '@space/logger';
import type { Clock } from '@space/time';

import type { SpaceAuth } from './auth-server';
import { AuthenticationRequiredError, OnboardingRequiredError } from './errors';

/**
 * The application-facing authentication interface.
 *
 * Everything outside this package talks to these functions. Nothing else imports
 * `better-auth`, so replacing the library would touch this file and no other.
 *
 * The distinction this module exists to enforce: *authentication* answers "who
 * is making this request", and the answer comes from the session cookie alone.
 * A user identifier supplied by the browser is data, never authority.
 */

/** The authenticated user, as the application understands it. */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly imageUrl: string | null;
  /** Null until onboarding completes. */
  readonly onboardingCompletedAt: Date | null;
  readonly onboardingCompleted: boolean;
}

export interface SessionContext {
  readonly user: AuthenticatedUser;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

export interface AuthService {
  /** The underlying server, for the catch-all route handler only. */
  readonly auth: SpaceAuth;
  /** Resolves the session, or `null` when there is none. Never throws for anonymity. */
  getOptionalUser: (headers: Headers) => Promise<SessionContext | null>;
  /** Resolves the session or throws {@link AuthenticationRequiredError}. */
  requireUser: (headers: Headers) => Promise<SessionContext>;
  /** Resolves an onboarded session, or throws {@link OnboardingRequiredError}. */
  requireOnboardedUser: (headers: Headers) => Promise<SessionContext>;
  /** Ends every session for a user. Used by sign-out-everywhere and deletion. */
  revokeAllSessions: (userId: string) => Promise<number>;
}

export interface CreateAuthServiceOptions {
  auth: SpaceAuth;
  database: DatabaseClient;
  logger: Logger;
  /**
   * Supplied by the composition root.
   *
   * Session expiry and `lastSeenAt` are decided here rather than by the host
   * clock, so a test can move time and observe an expired session.
   */
  clock: Clock;
}

/**
 * How stale `lastSeenAt` may get before it is refreshed.
 *
 * Writing it on every request would add a write to every authenticated page
 * load for information that is only ever read at hour granularity.
 */
const LAST_SEEN_REFRESH_MS = 60 * 60 * 1000;

export const createAuthService = ({
  auth,
  database,
  logger,
  clock,
}: CreateAuthServiceOptions): AuthService => {
  const authLogger = logger.child({ component: 'auth' });

  const getOptionalUser = async (headers: Headers): Promise<SessionContext | null> => {
    const result = await auth.api.getSession({ headers });

    if (!result?.session || !result.user) {
      return null;
    }

    const expiresAt = new Date(result.session.expiresAt);

    // The library checks expiry too. Re-checking against the injected clock
    // keeps the rule testable and means a clock skew between the database and
    // the application cannot silently extend a session.
    if (expiresAt.getTime() <= clock.nowMs()) {
      authLogger.info({ userId: result.user.id }, 'session rejected: expired');
      return null;
    }

    /**
     * The session says *who*; the application row says *whether they may*.
     *
     * A suspended or soft-deleted account keeps its session row until it is
     * swept, so authorisation is re-derived from the user record on every
     * request rather than trusted from the token.
     */
    const account = await database.user.findUnique({
      where: { id: result.user.id },
      select: {
        id: true,
        email: true,
        name: true,
        imageUrl: true,
        status: true,
        deletedAt: true,
        lastSeenAt: true,
        onboardingCompletedAt: true,
      },
    });

    if (!account || account.deletedAt !== null || account.status !== 'ACTIVE') {
      authLogger.warn(
        { userId: result.user.id, reason: account ? account.status : 'missing' },
        'session rejected: account not active',
      );
      return null;
    }

    const now = clock.now();
    if (
      account.lastSeenAt === null ||
      now.getTime() - account.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS
    ) {
      await database.user.update({ where: { id: account.id }, data: { lastSeenAt: now } });
    }

    return {
      sessionId: result.session.id,
      expiresAt,
      user: {
        id: account.id,
        email: account.email,
        name: account.name,
        imageUrl: account.imageUrl,
        onboardingCompletedAt: account.onboardingCompletedAt,
        onboardingCompleted: account.onboardingCompletedAt !== null,
      },
    };
  };

  const requireUser = async (headers: Headers): Promise<SessionContext> => {
    const context = await getOptionalUser(headers);

    if (!context) {
      throw new AuthenticationRequiredError();
    }

    return context;
  };

  return {
    auth,
    getOptionalUser,
    requireUser,

    requireOnboardedUser: async (headers) => {
      const context = await requireUser(headers);

      if (!context.user.onboardingCompleted) {
        throw new OnboardingRequiredError();
      }

      return context;
    },

    revokeAllSessions: async (userId) => {
      // Deleting the rows is what makes revocation immediate: the next request
      // presenting an old cookie finds nothing to resolve.
      const result = await database.session.deleteMany({ where: { userId } });
      authLogger.info({ userId, revoked: result.count }, 'all sessions revoked');
      return result.count;
    },
  };
};
