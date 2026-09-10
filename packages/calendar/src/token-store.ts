import {
  decryptCredential,
  encryptCredential,
  isEncryptedCredential,
  type Keyring,
} from '@space/auth';

import { CalendarError } from './errors';

/**
 * Encrypted custody of Google Calendar OAuth tokens.
 *
 * Tokens are AEAD ciphertext at rest (`spc.v1.<keyId>.<nonce>.<ciphertext>.
 * <tag>`), written with the same keyring `@space/auth` uses for identity tokens
 * but with `calendar.*` purposes bound into the authenticated data. The purpose
 * binding means a calendar access token can never be substituted into an
 * identity column (or vice versa) without failing authentication.
 *
 * Encrypt is called in the OAuth callback, decrypt in the sync worker. Neither
 * path ever logs a token; these functions raise {@link CalendarError} before a
 * value can be logged.
 */

const ACCESS_TOKEN_PURPOSE = 'calendar.accessToken' as const;
const REFRESH_TOKEN_PURPOSE = 'calendar.refreshToken' as const;

/** Google OAuth tokens for one connection, still in ciphertext. */
export interface EncryptedCalendarTokens {
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
}

/** Google OAuth tokens decrypted, in memory for the shortest time possible. */
export interface DecryptedCalendarTokens {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
}

export const encryptCalendarTokens = (
  keyring: Keyring,
  tokens: {
    accessToken: string;
    refreshToken: string | null;
    accessTokenExpiresAt: Date | null;
  },
): EncryptedCalendarTokens => {
  if (tokens.accessToken.length === 0) {
    throw new CalendarError('Refusing to encrypt an empty calendar access token.');
  }

  return {
    accessToken: encryptCredential(keyring, tokens.accessToken, ACCESS_TOKEN_PURPOSE),
    refreshToken:
      tokens.refreshToken && tokens.refreshToken.length > 0
        ? encryptCredential(keyring, tokens.refreshToken, REFRESH_TOKEN_PURPOSE)
        : null,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
  };
};

export const decryptCalendarTokens = (
  keyring: Keyring,
  encrypted: {
    accessToken: string | null;
    refreshToken: string | null;
  },
): DecryptedCalendarTokens => {
  let accessToken: string | null = null;
  let refreshToken: string | null = null;

  if (encrypted.accessToken) {
    if (!isEncryptedCredential(encrypted.accessToken)) {
      throw new CalendarError('Stored calendar access token is not encrypted.');
    }
    accessToken = decryptCredential(keyring, encrypted.accessToken, ACCESS_TOKEN_PURPOSE);
  }

  if (encrypted.refreshToken) {
    if (!isEncryptedCredential(encrypted.refreshToken)) {
      throw new CalendarError('Stored calendar refresh token is not encrypted.');
    }
    refreshToken = decryptCredential(keyring, encrypted.refreshToken, REFRESH_TOKEN_PURPOSE);
  }

  if (accessToken === null) {
    throw new CalendarError('Calendar connection has no access token.');
  }

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: null,
  };
};
