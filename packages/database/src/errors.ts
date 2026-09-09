import { Prisma } from './generated/prisma/client';

/**
 * Domain-shaped errors for the failures callers actually handle.
 *
 * Prisma's error codes are an implementation detail of the persistence layer. If
 * they leaked upward, every route handler would end up matching on `'P2002'`,
 * and swapping the data layer would become a rewrite.
 */

export class DatabaseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseError';
  }
}

/** A uniqueness constraint rejected the write. */
export class UniqueConstraintError extends DatabaseError {
  readonly fields: readonly string[];

  constructor(fields: readonly string[], options?: { cause?: unknown }) {
    super(`A record with the same ${fields.join(', ') || 'value'} already exists.`, options);
    this.name = 'UniqueConstraintError';
    this.fields = fields;
  }
}

/** The row does not exist, or does not belong to this user. */
export class RecordNotFoundError extends DatabaseError {
  readonly entity: string;

  constructor(entity: string, options?: { cause?: unknown }) {
    // The message never distinguishes "absent" from "not yours": telling those
    // apart would let a caller enumerate other users' identifiers.
    super(`${entity} not found.`, options);
    this.name = 'RecordNotFoundError';
    this.entity = entity;
  }
}

/** A foreign key pointed at something that is not there. */
export class ReferenceError_ extends DatabaseError {
  constructor(field: string, options?: { cause?: unknown }) {
    super(`Referenced record for "${field}" does not exist.`, options);
    this.name = 'ReferenceError';
  }
}

/** A domain rule rejected the change, e.g. an illegal task status transition. */
export class InvalidTransitionError extends DatabaseError {
  readonly from: string;
  readonly to: string;

  constructor(entity: string, from: string, to: string) {
    super(`${entity} cannot move from ${from} to ${to}.`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

const readTargetFields = (meta: unknown): string[] => {
  if (typeof meta !== 'object' || meta === null || !('target' in meta)) {
    return [];
  }

  const { target } = meta as { target?: unknown };
  if (Array.isArray(target)) {
    return target.filter((value): value is string => typeof value === 'string');
  }

  return typeof target === 'string' ? [target] : [];
};

/**
 * Translates a Prisma error into a domain error.
 *
 * Unrecognised errors are wrapped rather than re-thrown raw, so a stack trace
 * carrying a connection string can never escape this layer.
 */
export const toDomainError = (error: unknown, entity: string): Error => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002':
        return new UniqueConstraintError(readTargetFields(error.meta), { cause: error });
      case 'P2025':
        return new RecordNotFoundError(entity, { cause: error });
      case 'P2003':
        return new ReferenceError_(readTargetFields(error.meta)[0] ?? 'relation', { cause: error });
      default:
        return new DatabaseError(`Database rejected the operation (${error.code}).`, {
          cause: error,
        });
    }
  }

  if (error instanceof DatabaseError) {
    return error;
  }

  return new DatabaseError('Unexpected database failure.', { cause: error });
};

/** Runs `operation`, converting any Prisma failure into a domain error. */
export const withDomainErrors = async <T>(
  entity: string,
  operation: () => Promise<T>,
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    throw toDomainError(error, entity);
  }
};
