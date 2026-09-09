import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CredentialCryptoError,
  decryptCredential,
  encryptCredential,
  isEncryptedCredential,
  readKeyId,
} from '../crypto/aead';
import { createKeyring, generateEncryptionKey } from '../crypto/keyring';

const REFRESH_TOKEN = '1//0gTopSecretGoogleRefreshTokenValue-abcdefghijklmnop';

const keyEntry = (id: string) => `${id}:${randomBytes(32).toString('base64')}`;

const keyring = (active = keyEntry('k1'), previous?: string) =>
  createKeyring({ activeKey: active, previousKeys: previous });

describe('keyring', () => {
  it('accepts a well-formed key', () => {
    const ring = keyring();

    expect(ring.activeKey().id).toBe('k1');
    expect(ring.activeKey().material).toHaveLength(32);
    expect(ring.keyIds()).toEqual(['k1']);
  });

  it('generates keys of the right shape', () => {
    const generated = generateEncryptionKey('k2026');

    expect(() => createKeyring({ activeKey: generated })).not.toThrow();
    expect(generated.startsWith('k2026:')).toBe(true);
  });

  it.each([
    ['missing separator', 'notakey'],
    ['empty id', ':aGVsbG8='],
    ['invalid id characters', `K1!:${randomBytes(32).toString('base64')}`],
    ['key too short', `k1:${randomBytes(16).toString('base64')}`],
    ['key too long', `k1:${randomBytes(48).toString('base64')}`],
  ])('rejects a key with %s', (_label, entry) => {
    expect(() => createKeyring({ activeKey: entry })).toThrow(CredentialCryptoError);
  });

  it('never puts key material into an error message', () => {
    const secret = randomBytes(16).toString('base64');

    try {
      createKeyring({ activeKey: `k1:${secret}` });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('rejects two keys sharing an id', () => {
    expect(() =>
      createKeyring({ activeKey: keyEntry('k1'), previousKeys: keyEntry('k1') }),
    ).toThrow(/Duplicate encryption key id/);
  });

  it('keeps retired keys available for decryption', () => {
    const ring = keyring(keyEntry('k2'), `${keyEntry('k1')}, ${keyEntry('k0')}`);

    expect(ring.keyIds()).toEqual(['k2', 'k1', 'k0']);
    expect(ring.activeKey().id).toBe('k2');
    expect(ring.keyById('k0')).toBeDefined();
  });
});

describe('encryptCredential / decryptCredential', () => {
  it('round-trips a credential', () => {
    const ring = keyring();
    const sealed = encryptCredential(ring, REFRESH_TOKEN, 'account.refreshToken');

    expect(decryptCredential(ring, sealed, 'account.refreshToken')).toBe(REFRESH_TOKEN);
  });

  it('never leaves the plaintext visible in the ciphertext', () => {
    const sealed = encryptCredential(keyring(), REFRESH_TOKEN, 'account.refreshToken');

    expect(sealed).not.toContain(REFRESH_TOKEN);
    expect(sealed).not.toContain('TopSecret');
    expect(Buffer.from(sealed, 'utf8').includes(REFRESH_TOKEN)).toBe(false);
  });

  it('produces a self-describing payload carrying version and key id', () => {
    const sealed = encryptCredential(
      keyring(keyEntry('k7')),
      REFRESH_TOKEN,
      'account.refreshToken',
    );
    const [format, version, keyId, nonce, ciphertext, tag] = sealed.split('.');

    expect(format).toBe('spc');
    expect(version).toBe('v1');
    expect(keyId).toBe('k7');
    // Nonce, ciphertext and tag are distinct segments, not one packed blob.
    expect(Buffer.from(nonce ?? '', 'base64url')).toHaveLength(12);
    expect(Buffer.from(tag ?? '', 'base64url')).toHaveLength(16);
    expect((ciphertext ?? '').length).toBeGreaterThan(0);
    expect(readKeyId(sealed)).toBe('k7');
    expect(isEncryptedCredential(sealed)).toBe(true);
  });

  it('uses a fresh nonce, so the same credential encrypts differently each time', () => {
    const ring = keyring();
    const first = encryptCredential(ring, REFRESH_TOKEN, 'account.refreshToken');
    const second = encryptCredential(ring, REFRESH_TOKEN, 'account.refreshToken');

    expect(first).not.toBe(second);
    expect(decryptCredential(ring, second, 'account.refreshToken')).toBe(REFRESH_TOKEN);
  });

  it('refuses to encrypt an empty credential', () => {
    expect(() => encryptCredential(keyring(), '', 'account.refreshToken')).toThrow(
      /empty credential/,
    );
  });
});

describe('tamper resistance', () => {
  const corrupt = (payload: string, segment: number): string => {
    const parts = payload.split('.');
    const raw = Buffer.from(parts[segment] ?? '', 'base64url');
    raw[0] = (raw[0] ?? 0) ^ 0xff;
    parts[segment] = raw.toString('base64url');
    return parts.join('.');
  };

  it.each([
    ['nonce', 3],
    ['ciphertext', 4],
    ['authentication tag', 5],
  ])('rejects a payload with a corrupted %s', (_label, segment) => {
    const ring = keyring();
    const sealed = encryptCredential(ring, REFRESH_TOKEN, 'account.refreshToken');

    expect(() => decryptCredential(ring, corrupt(sealed, segment), 'account.refreshToken')).toThrow(
      CredentialCryptoError,
    );
  });

  it('rejects a payload encrypted under a different key', () => {
    const sealed = encryptCredential(
      keyring(keyEntry('k1')),
      REFRESH_TOKEN,
      'account.refreshToken',
    );
    // Same key id, different material: the tag check must fail.
    const impostor = keyring(keyEntry('k1'));

    expect(() => decryptCredential(impostor, sealed, 'account.refreshToken')).toThrow(
      /failed authentication/,
    );
  });

  it('rejects a payload whose key is not in the ring', () => {
    const sealed = encryptCredential(
      keyring(keyEntry('k9')),
      REFRESH_TOKEN,
      'account.refreshToken',
    );

    expect(() =>
      decryptCredential(keyring(keyEntry('k1')), sealed, 'account.refreshToken'),
    ).toThrow(/No encryption key available for key id "k9"/);
  });

  it('rejects a credential replayed into a different field', () => {
    // An access token moved into the refresh-token column must not decrypt.
    const ring = keyring();
    const sealed = encryptCredential(ring, REFRESH_TOKEN, 'account.accessToken');

    expect(() => decryptCredential(ring, sealed, 'account.refreshToken')).toThrow(
      /failed authentication/,
    );
  });

  it.each([
    ['empty string', ''],
    ['plaintext', REFRESH_TOKEN],
    ['too few segments', 'spc.v1.k1.abc'],
    ['unknown format', 'xyz.v1.k1.AAAA.AAAA.AAAA'],
    ['unsupported version', 'spc.v9.k1.AAAA.AAAA.AAAA'],
    ['empty nonce', 'spc.v1.k1..AAAA.AAAA'],
  ])('fails safely on %s', (_label, payload) => {
    expect(() => decryptCredential(keyring(), payload, 'account.refreshToken')).toThrow(
      CredentialCryptoError,
    );
  });

  it('never echoes the payload or plaintext in a failure message', () => {
    const ring = keyring();
    const sealed = encryptCredential(ring, REFRESH_TOKEN, 'account.refreshToken');
    const tampered = corrupt(sealed, 4);

    try {
      decryptCredential(ring, tampered, 'account.refreshToken');
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(REFRESH_TOKEN);
      expect(message).not.toContain(tampered);
    }
  });
});

describe('key rotation', () => {
  it('decrypts old ciphertext after the active key changes', () => {
    const oldKey = keyEntry('k1');
    const newKey = keyEntry('k2');

    const before = encryptCredential(keyring(oldKey), REFRESH_TOKEN, 'account.refreshToken');

    // Rotation: k2 becomes active, k1 stays in the ring as decrypt-only.
    const rotated = keyring(newKey, oldKey);

    expect(decryptCredential(rotated, before, 'account.refreshToken')).toBe(REFRESH_TOKEN);

    const after = encryptCredential(rotated, REFRESH_TOKEN, 'account.refreshToken');
    expect(readKeyId(after)).toBe('k2');
    expect(decryptCredential(rotated, after, 'account.refreshToken')).toBe(REFRESH_TOKEN);
  });

  it('stops decrypting once the retired key is removed', () => {
    const oldKey = keyEntry('k1');
    const sealed = encryptCredential(keyring(oldKey), REFRESH_TOKEN, 'account.refreshToken');

    // The failure is explicit and names the id, so an early retirement is
    // diagnosable rather than mysterious.
    expect(() =>
      decryptCredential(keyring(keyEntry('k2')), sealed, 'account.refreshToken'),
    ).toThrow(/No encryption key available for key id "k1"/);
  });
});
