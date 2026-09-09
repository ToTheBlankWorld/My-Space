import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

import type { EncryptionKey, Keyring } from './keyring';

/**
 * Authenticated encryption for OAuth credentials.
 *
 * A Google refresh token is a long-lived bearer credential: whoever holds it can
 * act as the user against Google until it is revoked. It must never sit in the
 * database in plaintext, where a backup, a read replica, a log of a query, or a
 * compromised database account would expose it.
 *
 * AES-256-GCM is used because it is authenticated: tampering with the stored
 * value produces a decryption failure rather than a silently altered plaintext.
 * Node's built-in `crypto` provides it, so this adds no dependency.
 */

/** Ciphertext format marker. Bumping it changes how a payload is parsed. */
const FORMAT = 'spc';
const VERSION = 'v1';

const ALGORITHM = 'aes-256-gcm';
/** 96 bits, the size GCM is specified and optimised for. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Raised when a credential cannot be encrypted or decrypted. */
export class CredentialCryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    // The message never contains plaintext, ciphertext or key material: these
    // errors are logged, and a log is not a safe place for any of the three.
    super(message, options);
    this.name = 'CredentialCryptoError';
  }
}

/**
 * What a ciphertext is for.
 *
 * Bound into the additional authenticated data, so a value encrypted for one
 * field cannot be pasted into another — an access token cannot be moved into the
 * refresh-token column, and a credential cannot be replayed into an unrelated
 * feature that shares the key.
 */
export type CredentialPurpose = 'account.accessToken' | 'account.refreshToken' | 'account.idToken';

const encodeSegment = (value: Buffer): string => value.toString('base64url');

const decodeSegment = (value: string, field: string): Buffer => {
  const decoded = Buffer.from(value, 'base64url');

  if (decoded.length === 0) {
    throw new CredentialCryptoError(`Credential ciphertext has an empty ${field}.`);
  }

  return decoded;
};

/**
 * Additional authenticated data.
 *
 * Not secret, but covered by the authentication tag: an attacker who swaps the
 * key id or the purpose invalidates the tag instead of getting a decryption in a
 * context we did not intend.
 */
const buildAad = (keyId: string, purpose: CredentialPurpose): Buffer =>
  Buffer.from(`${FORMAT}.${VERSION}.${keyId}.${purpose}`, 'utf8');

/**
 * Encrypts a credential with the keyring's active key.
 *
 * The result is a self-describing string:
 * `spc.v1.<keyId>.<nonce>.<ciphertext>.<tag>` — format, version and key id are
 * metadata; nonce, ciphertext and tag are separate base64url segments, so
 * nothing has to be re-derived by position or length at read time.
 */
export const encryptCredential = (
  keyring: Keyring,
  plaintext: string,
  purpose: CredentialPurpose,
): string => {
  if (plaintext.length === 0) {
    throw new CredentialCryptoError('Refusing to encrypt an empty credential.');
  }

  const key: EncryptionKey = keyring.activeKey();
  // A fresh random nonce per encryption. Reusing one under the same key is the
  // single catastrophic mistake available in GCM.
  const nonce = randomBytes(NONCE_BYTES);

  const cipher = createCipheriv(ALGORITHM, key.material, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(buildAad(key.id, purpose));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    FORMAT,
    VERSION,
    key.id,
    encodeSegment(nonce),
    encodeSegment(ciphertext),
    encodeSegment(tag),
  ].join('.');
};

/** True when `value` looks like a payload this module produced. */
export const isEncryptedCredential = (value: string): boolean =>
  value.startsWith(`${FORMAT}.${VERSION}.`) && value.split('.').length === 6;

/**
 * Decrypts a credential.
 *
 * The key is chosen by the key id embedded in the payload, which is what makes
 * rotation possible: a retired key stays in the keyring as decrypt-only until
 * every row has been re-encrypted.
 */
export const decryptCredential = (
  keyring: Keyring,
  payload: string,
  purpose: CredentialPurpose,
): string => {
  const segments = payload.split('.');

  if (segments.length !== 6) {
    throw new CredentialCryptoError('Credential ciphertext is malformed.');
  }

  const [format, version, keyId, nonceSegment, ciphertextSegment, tagSegment] = segments as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  if (format !== FORMAT) {
    throw new CredentialCryptoError('Credential ciphertext has an unknown format.');
  }

  if (version !== VERSION) {
    throw new CredentialCryptoError(`Credential ciphertext has unsupported version "${version}".`);
  }

  const key = keyring.keyById(keyId);

  if (!key) {
    // Naming the id is safe and is the only way to diagnose a rotation that
    // retired a key too early.
    throw new CredentialCryptoError(`No encryption key available for key id "${keyId}".`);
  }

  const nonce = decodeSegment(nonceSegment, 'nonce');
  const ciphertext = decodeSegment(ciphertextSegment, 'ciphertext');
  const tag = decodeSegment(tagSegment, 'authentication tag');

  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new CredentialCryptoError('Credential ciphertext has invalid segment lengths.');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key.material, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(buildAad(key.id, purpose));
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    // A failed tag check means the payload was tampered with, was encrypted for
    // a different purpose, or the key is wrong. All three are the same answer to
    // a caller, and none of them may leak a partial plaintext.
    throw new CredentialCryptoError('Credential failed authentication and was not decrypted.', {
      cause: error,
    });
  }
};

/** Constant-time comparison, for callers that verify a decrypted credential. */
export const credentialsMatch = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');

  // `timingSafeEqual` throws on a length mismatch, which is itself a leak of
  // length only — acceptable, and unavoidable without padding.
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The key id a payload was encrypted with, without decrypting it. */
export const readKeyId = (payload: string): string | null => {
  const segments = payload.split('.');
  return segments.length === 6 && segments[0] === FORMAT ? (segments[2] ?? null) : null;
};
