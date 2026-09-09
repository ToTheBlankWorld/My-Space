import { describe, expect, it } from 'vitest';

import {
  DatabaseError,
  InvalidTransitionError,
  RecordNotFoundError,
  UniqueConstraintError,
  toDomainError,
  withDomainErrors,
} from '../errors';
import { Prisma } from '../generated/prisma/client';

const knownRequestError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('database said no', {
    code,
    clientVersion: 'test',
    meta,
  });

describe('toDomainError', () => {
  it('maps a unique violation and names the columns', () => {
    const error = toDomainError(
      knownRequestError('P2002', { target: ['userId', 'date'] }),
      'Space',
    );

    expect(error).toBeInstanceOf(UniqueConstraintError);
    expect((error as UniqueConstraintError).fields).toEqual(['userId', 'date']);
    expect(error.message).toContain('userId, date');
  });

  it('accepts a string target as well as an array', () => {
    const error = toDomainError(knownRequestError('P2002', { target: 'email' }), 'User');

    expect((error as UniqueConstraintError).fields).toEqual(['email']);
  });

  it('maps a missing row', () => {
    const error = toDomainError(knownRequestError('P2025'), 'Task');

    expect(error).toBeInstanceOf(RecordNotFoundError);
    expect(error.message).toBe('Task not found.');
  });

  it('does not reveal whether a row is absent or merely someone else’s', () => {
    // Distinguishing the two would let a caller enumerate other users' ids.
    const error = toDomainError(knownRequestError('P2025'), 'Task');

    expect(error.message).not.toMatch(/permission|owner|forbidden/i);
  });

  it('wraps an unrecognised Prisma code without leaking its message', () => {
    const error = toDomainError(knownRequestError('P2034'), 'Task');

    expect(error).toBeInstanceOf(DatabaseError);
    expect(error.message).toBe('Database rejected the operation (P2034).');
  });

  it('wraps a non-Prisma failure, so a connection string cannot escape', () => {
    const raw = new Error('connect ECONNREFUSED postgres://user:hunter2@db:5432');
    const error = toDomainError(raw, 'Task');

    expect(error).toBeInstanceOf(DatabaseError);
    expect(error.message).toBe('Unexpected database failure.');
    expect(error.message).not.toContain('hunter2');
    // The original is still attached for server-side logging.
    expect(error.cause).toBe(raw);
  });

  it('passes an already-domain error through unchanged', () => {
    const original = new InvalidTransitionError('Task', 'COMPLETED', 'PLANNED');

    expect(toDomainError(original, 'Task')).toBe(original);
  });
});

describe('withDomainErrors', () => {
  it('returns the value when the operation succeeds', async () => {
    await expect(withDomainErrors('Task', () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('converts a thrown Prisma error', async () => {
    await expect(
      withDomainErrors('Space', () =>
        Promise.reject(knownRequestError('P2002', { target: ['id'] })),
      ),
    ).rejects.toBeInstanceOf(UniqueConstraintError);
  });
});

describe('InvalidTransitionError', () => {
  it('names both ends of the rejected move', () => {
    const error = new InvalidTransitionError('Task', 'COMPLETED', 'IN_PROGRESS');

    expect(error.message).toBe('Task cannot move from COMPLETED to IN_PROGRESS.');
    expect(error.from).toBe('COMPLETED');
    expect(error.to).toBe('IN_PROGRESS');
  });
});
