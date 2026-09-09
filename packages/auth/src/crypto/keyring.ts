import { randomBytes } from 'node:crypto';

import { CredentialCryptoError } from './aead';

/**
 * The application's credential encryption keys.
 *
 * One key is active and does all encryption. Retired keys stay in the ring as
 * decrypt-only so that a rotation does not have to be atomic: new writes use the
 * new key immediately, old rows keep decrypting until they are re-encrypted.
 *
 * Keys come from the environment. They are never stored in the database — a key
 * kept beside the ciphertext it protects is not a key.
 */

/** Exactly 256 bits, the key size AES-256-GCM requires. */
const KEY_BYTES = 32;

/** Key ids appear in every ciphertext, so they stay short and URL-safe. */
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface EncryptionKey {
  readonly id: string;
  readonly material: Buffer;
}

export interface Keyring {
  /** The key new ciphertext is written with. */
  activeKey: () => EncryptionKey;
  /** Look up any key the ring holds, active or retired. */
  keyById: (id: string) => EncryptionKey | undefined;
  /** Ids in the ring, active first. Used by the rotation report. */
  keyIds: () => readonly string[];
}

/**
 * Parses one `<keyId>:<base64 key>` entry.
 *
 * The id is carried in the ciphertext rather than derived from the key, so a key
 * can be replaced without any ambiguity about which one produced a given row.
 */
const parseKey = (entry: string, label: string): EncryptionKey => {
  const separator = entry.indexOf(':');

  if (separator <= 0) {
    throw new CredentialCryptoError(`${label} must be formatted as "<keyId>:<base64 key>".`);
  }

  const id = entry.slice(0, separator).trim();
  const encoded = entry.slice(separator + 1).trim();

  if (!KEY_ID_PATTERN.test(id)) {
    throw new CredentialCryptoError(
      `${label} has an invalid key id. Use lower-case letters, digits, hyphen or underscore.`,
    );
  }

  let material: Buffer;
  try {
    material = Buffer.from(encoded, 'base64');
  } catch (error) {
    throw new CredentialCryptoError(`${label} is not valid base64.`, { cause: error });
  }

  if (material.length !== KEY_BYTES) {
    // The length is safe to report; the material never is.
    throw new CredentialCryptoError(
      `${label} must decode to exactly ${KEY_BYTES} bytes, got ${material.length}.`,
    );
  }

  return { id, material };
};

export interface KeyringInput {
  /** `<keyId>:<base64 key>` — the key everything is encrypted with. */
  activeKey: string;
  /**
   * Retired keys, decrypt-only, as a comma-separated list of the same format.
   *
   * Present only during a rotation. Removing an id from here before every row
   * has been re-encrypted makes those rows unreadable, which is why
   * {@link Keyring.keyIds} exists and the rotation runbook checks it.
   */
  previousKeys?: string | undefined;
}

/**
 * Builds a keyring, failing loudly on anything malformed.
 *
 * Configuration is resolved once at boot rather than per request: a process with
 * an unusable key must not start and then fail on the first sign-in.
 */
export const createKeyring = ({ activeKey, previousKeys }: KeyringInput): Keyring => {
  const active = parseKey(activeKey, 'OAUTH_ENCRYPTION_KEY');

  const retired = (previousKeys ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseKey(entry, 'OAUTH_ENCRYPTION_PREVIOUS_KEYS'));

  const byId = new Map<string, EncryptionKey>();
  byId.set(active.id, active);

  for (const key of retired) {
    if (byId.has(key.id)) {
      // Two different keys sharing an id would make the id meaningless and could
      // silently decrypt with the wrong one.
      throw new CredentialCryptoError(
        `Duplicate encryption key id "${key.id}". Every key must have a distinct id.`,
      );
    }
    byId.set(key.id, key);
  }

  return {
    activeKey: () => active,
    keyById: (id) => byId.get(id),
    keyIds: () => [active.id, ...retired.map((key) => key.id)],
  };
};

/**
 * Generates a key entry suitable for `OAUTH_ENCRYPTION_KEY`.
 *
 * Used by the setup documentation and by tests. Never call it at runtime to
 * "fill in" a missing key: a generated-on-boot key would make every existing
 * ciphertext undecryptable on the next restart.
 */
export const generateEncryptionKey = (id: string): string => {
  if (!KEY_ID_PATTERN.test(id)) {
    throw new CredentialCryptoError('Key id must match /^[a-z0-9][a-z0-9_-]{0,31}$/.');
  }

  return `${id}:${randomBytes(KEY_BYTES).toString('base64')}`;
};
