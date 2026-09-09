import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ValidationError, formatIssues, parseOrThrow } from '../parse';
import { booleanFromEnvSchema, httpUrlSchema, nonEmptyStringSchema } from '../primitives';

const schema = z.object({
  name: nonEmptyStringSchema,
  url: httpUrlSchema,
});

describe('parseOrThrow', () => {
  it('returns the parsed value when the input is valid', () => {
    expect(
      parseOrThrow(schema, { name: 'space', url: 'https://space.test' }, 'test input'),
    ).toEqual({ name: 'space', url: 'https://space.test' });
  });

  it('throws a ValidationError listing every issue', () => {
    expect(() =>
      parseOrThrow(schema, { name: '  ', url: 'ftp://space.test' }, 'test input'),
    ).toThrow(ValidationError);

    try {
      parseOrThrow(schema, { name: '  ', url: 'ftp://space.test' }, 'test input');
    } catch (error) {
      const issues = (error as ValidationError).issues;
      expect(issues).toHaveLength(2);
      expect(issues.join('\n')).toContain('name:');
      expect(issues.join('\n')).toContain('url:');
    }
  });

  it('never echoes the rejected value, so secrets cannot leak into logs', () => {
    const secretSchema = z.object({ token: httpUrlSchema });

    try {
      parseOrThrow(secretSchema, { token: 'super-secret-value' }, 'credentials');
    } catch (error) {
      expect((error as ValidationError).message).not.toContain('super-secret-value');
    }
  });
});

describe('formatIssues', () => {
  it('prefixes each message with its path', () => {
    const result = z.object({ nested: z.object({ port: z.number() }) }).safeParse({ nested: {} });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatIssues(result.error)[0]).toMatch(/^nested\.port: /);
    }
  });
});

describe('booleanFromEnvSchema', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ] as const)('maps %s to %s', (input, expected) => {
    expect(booleanFromEnvSchema.parse(input)).toBe(expected);
  });

  it('rejects strings that are neither truthy nor falsy spellings', () => {
    expect(booleanFromEnvSchema.safeParse('yes').success).toBe(false);
  });
});
