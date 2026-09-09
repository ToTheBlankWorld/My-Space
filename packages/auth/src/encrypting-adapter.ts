import type { DatabaseClient } from '@space/database';
import { prismaAdapter } from 'better-auth/adapters/prisma';

import { decryptCredential, encryptCredential, isEncryptedCredential } from './crypto/aead';
import type { CredentialPurpose } from './crypto/aead';
import type { Keyring } from './crypto/keyring';

/**
 * A Prisma adapter that encrypts OAuth credentials on the way to the database
 * and decrypts them on the way back.
 *
 * The encryption boundary is here, at the storage edge, rather than in a
 * database hook, for one reason: hooks only run on writes. Putting it in the
 * adapter means the authentication library keeps working with plaintext for
 * refresh flows while the database only ever holds ciphertext — no caller has to
 * remember to decrypt, and no future code path can accidentally persist a raw
 * token.
 *
 * Only the `account` model is touched. Everything else passes straight through.
 */

/** Columns that hold a bearer credential, and the purpose each is bound to. */
const ENCRYPTED_FIELDS: Readonly<Record<string, CredentialPurpose>> = {
  accessToken: 'account.accessToken',
  refreshToken: 'account.refreshToken',
  idToken: 'account.idToken',
};

const ACCOUNT_MODELS = new Set(['account', 'accounts']);

const isAccountModel = (model: string): boolean => ACCOUNT_MODELS.has(model.toLowerCase());

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null;

/** Encrypts every credential field present on a row being written. */
const sealRow = <T>(keyring: Keyring, data: T): T => {
  if (!isRow(data)) {
    return data;
  }

  let sealed: Row | undefined;

  for (const [field, purpose] of Object.entries(ENCRYPTED_FIELDS)) {
    const value = data[field];

    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }

    // Idempotent: a value that is already ciphertext is left alone, so an
    // update that echoes back a previously read row cannot double-encrypt.
    if (isEncryptedCredential(value)) {
      continue;
    }

    sealed ??= { ...data };
    sealed[field] = encryptCredential(keyring, value, purpose);
  }

  return (sealed ?? data) as T;
};

/**
 * Decrypts every credential field present on a row that was read.
 *
 * A value that is not recognisable ciphertext is returned untouched. That is the
 * migration path: rows written before encryption existed keep working, and the
 * next write seals them.
 */
const openRow = <T>(keyring: Keyring, data: T): T => {
  if (!isRow(data)) {
    return data;
  }

  let opened: Row | undefined;

  for (const [field, purpose] of Object.entries(ENCRYPTED_FIELDS)) {
    const value = data[field];

    if (typeof value !== 'string' || !isEncryptedCredential(value)) {
      continue;
    }

    opened ??= { ...data };
    opened[field] = decryptCredential(keyring, value, purpose);
  }

  return (opened ?? data) as T;
};

const openResult = <T>(keyring: Keyring, result: T): T => {
  if (Array.isArray(result)) {
    return result.map((row: unknown) => openRow(keyring, row)) as unknown as T;
  }

  return openRow(keyring, result);
};

type AdapterFactory = ReturnType<typeof prismaAdapter>;
type Adapter = ReturnType<AdapterFactory>;

interface ModelArgs {
  model: string;
  data?: unknown;
  update?: unknown;
}

/**
 * Wraps the Prisma adapter with transparent credential encryption.
 *
 * Written as a delegating proxy over the four methods that carry row data. Every
 * other method — `delete`, `count`, `transaction`, and anything a future version
 * adds — is preserved by the spread, so a library upgrade cannot silently lose a
 * capability.
 */
export const createEncryptingPrismaAdapter = (
  client: DatabaseClient,
  keyring: Keyring,
): AdapterFactory => {
  const factory = prismaAdapter(client, { provider: 'postgresql' });

  return (options) => {
    const inner = factory(options);

    const seal = <A extends ModelArgs>(args: A): A => {
      if (!isAccountModel(args.model)) {
        return args;
      }

      const next: ModelArgs = { ...args };

      if ('data' in args && args.data !== undefined) {
        next.data = sealRow(keyring, args.data);
      }
      if ('update' in args && args.update !== undefined) {
        next.update = sealRow(keyring, args.update);
      }

      return next as A;
    };

    const open = <R>(model: string, result: R): R =>
      isAccountModel(model) ? openResult(keyring, result) : result;

    return {
      ...inner,
      create: async (args) => open(args.model, await inner.create(seal(args))),
      update: async (args) => open(args.model, await inner.update(seal(args))),
      updateMany: async (args) => inner.updateMany(seal(args)),
      findOne: async (args) => open(args.model, await inner.findOne(args)),
      findMany: async (args) => open(args.model, await inner.findMany(args)),
    } satisfies Adapter;
  };
};
