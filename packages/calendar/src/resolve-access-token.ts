import type { Database } from '@space/database';
import type { Logger } from '@space/logger';
import type { Clock } from '@space/time';

import type { Keyring } from '@space/auth';

import { decryptCalendarTokens, encryptCalendarTokens } from './token-store';
import { refreshAccessToken, type GoogleClientCredentials } from './oauth';

/**
 * Resolves a fresh, decrypted access token for a connection before a sync.
 *
 * Ownership is enforced here (the `userId` is a load-bearing input, from the
 * job payload that the web route verified), unlike a repository read that would
 * accept a foreign `connectionId` and decrypt another user's tokens into this
 * process.
 *
 * Token handling:
 *   - Ciphertext is decrypted only in this module and the OAuth exchange; the
 *     plaintext exists in memory for the duration of the sync and nothing else.
 *   - An access token near expiry (or already expired) with a refresh token is
 *     refreshed and re-encrypted before the sync starts. The encrypted refresh
 *     token is written back verbatim.
 *   - A rejected refresh means the user revoked access: raised as
 *     {@link CalendarAuthError}, which the worker turns into a ERROR state and
 *     does not retry.
 */

const REFRESH_SKEW_MS = 30_000;

export interface ResolveAccessTokenDeps {
  db: Database;
  logger: Logger;
  clock: Clock;
  keyring: Keyring;
  google: GoogleClientCredentials;
}

export interface ResolveAccessTokenResult {
  /** Decrypted access token. */
  accessToken: string;
}

export const resolveConnectionAccessToken = async (
  deps: ResolveAccessTokenDeps,
  input: { userId: string; connectionId: string },
): Promise<ResolveAccessTokenResult | null> => {
  const { db, logger, clock, keyring, google } = deps;

  const connection = await db.calendarConnection.findFirst({
    where: {
      id: input.connectionId,
      userId: input.userId,
    },
  });

  if (!connection) {
    logger.warn({ connectionId: input.connectionId }, 'sync skipped: connection not found');
    return null;
  }

  if (connection.status !== 'CONNECTED') {
    logger.warn(
      { connectionId: input.connectionId, status: connection.status },
      'sync skipped: connection not connected',
    );
    return null;
  }

  const decrypted = decryptCalendarTokens(keyring, connection);

  // Refresh when the stored access token may already be expired at Google.
  const expiresAt = connection.accessTokenExpiresAt;
  const shouldRefresh =
    decrypted.refreshToken !== null &&
    (expiresAt === null || expiresAt.getTime() - clock.now().getTime() < REFRESH_SKEW_MS);

  let accessToken = decrypted.accessToken;

  if (shouldRefresh) {
    // A null is impossible here: `shouldRefresh` requires a refresh token.
    const refreshToken = decrypted.refreshToken as string;

    const refreshed = await refreshAccessToken(google, refreshToken);

    const reEncrypted = encryptCalendarTokens(keyring, {
      accessToken: refreshed.accessToken,
      refreshToken,
      accessTokenExpiresAt: refreshed.expiresAt,
    });

    await db.calendarConnection.update({
      where: { id: connection.id },
      data: {
        accessToken: reEncrypted.accessToken,
        accessTokenExpiresAt: refreshed.expiresAt,
      },
    });

    accessToken = refreshed.accessToken;
    logger.info({ connectionId: connection.id }, 'calendar access token refreshed');
  }

  return { accessToken };
};
