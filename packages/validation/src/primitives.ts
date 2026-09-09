import { z } from 'zod';

/** A string that is required to carry meaning — whitespace only is rejected. */
export const nonEmptyStringSchema = z.string().trim().min(1, { message: 'must not be empty' });

/**
 * An absolute `http`/`https` URL.
 *
 * Restricted to HTTP schemes so a configuration mistake cannot turn a public URL
 * into a `file:` or `javascript:` target.
 */
export const httpUrlSchema = z
  .url({ message: 'must be an absolute URL' })
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'must use the http or https scheme',
  });

/** A TCP port usable by an application process. */
export const portSchema = z.coerce.number().int().min(1).max(65_535);

/**
 * A boolean supplied through the environment.
 *
 * Environment variables are always strings, and `Boolean('false')` is `true`,
 * so the accepted spellings are enumerated explicitly.
 */
export const booleanFromEnvSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');
