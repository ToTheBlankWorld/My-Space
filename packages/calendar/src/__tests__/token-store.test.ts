import { createKeyring, encryptCredential, generateEncryptionKey, type Keyring } from '@space/auth';
import { describe, expect, it } from 'vitest';

import { CalendarError } from '../errors';
import { decryptCalendarTokens, encryptCalendarTokens } from '../token-store';

/**
 * Token custody tests.
 *
 * These one-time construction functions are cheap enough that each test builds
 * the whole pipeline (keyring -> encrypt -> decrypt) rather than stubbing it:
 * the value under test is precisely this pipeline, and a stub would test nothing.
 */

const buildKeyring = (): Keyring => createKeyring({ activeKey: generateEncryptionKey('test') });

const TOKENS = {
  accessToken: 'ya29.access-token',
  refreshToken: '1//refresh-token',
  accessTokenExpiresAt: new Date('2026-03-30T10:00:00.000Z'),
};

describe('encryptCalendarTokens', () => {
  it('refuses to encrypt an empty access token', () => {
    expect(() => encryptCalendarTokens(buildKeyring(), { ...TOKENS, accessToken: '' })).toThrow(
      CalendarError,
    );
  });

  it('encrypts access and refresh tokens under distinct ciphertexts', () => {
    const encrypted = encryptCalendarTokens(buildKeyring(), TOKENS);

    expect(encrypted.accessToken).not.toBe(TOKENS.accessToken);
    expect(encrypted.refreshToken).not.toBe(TOKENS.refreshToken);
    expect(encrypted.accessToken).not.toBe(encrypted.refreshToken);
  });
});

describe('decryptCalendarTokens', () => {
  it('round-trips encrypted tokens back to the plaintext', () => {
    const keyring = buildKeyring();
    const encrypted = encryptCalendarTokens(keyring, TOKENS);
    const decrypted = decryptCalendarTokens(keyring, encrypted);

    expect(decrypted.accessToken).toBe(TOKENS.accessToken);
    expect(decrypted.refreshToken).toBe(TOKENS.refreshToken);
  });

  it('returns nulls for absent tokens', () => {
    const keyring = buildKeyring();
    const encrypted = encryptCalendarTokens(keyring, { ...TOKENS, refreshToken: null });

    expect(encrypted.refreshToken).toBeNull();
    expect(decryptCalendarTokens(keyring, encrypted).refreshToken).toBeNull();
  });

  it('throws when a stored access token is plaintext', () => {
    expect(() =>
      decryptCalendarTokens(buildKeyring(), {
        accessToken: 'raw-token',
        refreshToken: null,
      }),
    ).toThrow(CalendarError);
  });

  it('throws when the ciphertext was encrypted for a different purpose', () => {
    // The identity purpose and the calendar purpose must never be interchangeable.
    const keyring = buildKeyring();
    const identityCiphertext = encryptCredential(keyring, TOKENS.accessToken, 'account.idToken');

    expect(() =>
      decryptCalendarTokens(keyring, {
        accessToken: identityCiphertext,
        refreshToken: null,
      }),
    ).toThrow();
  });

  it('throws when there is no access token at all', () => {
    expect(() =>
      decryptCalendarTokens(buildKeyring(), { accessToken: null, refreshToken: null }),
    ).toThrow(CalendarError);
  });
});
