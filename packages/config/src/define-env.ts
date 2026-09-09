import { ValidationError, parseOrThrow } from '@space/validation';
import type { z } from 'zod';

/** A raw, unvalidated environment map — usually `process.env`. */
export type EnvSource = Record<string, string | undefined>;

/** Raised when a process starts with a missing or malformed environment. */
export class EnvironmentError extends Error {
  public readonly issues: readonly string[];

  constructor(scope: string, issues: readonly string[]) {
    super(
      `Invalid environment for "${scope}". Fix the following and restart:\n${issues
        .map((issue) => `  - ${issue}`)
        .join('\n')}\n\nSee .env.example for the expected variables.`,
    );
    this.name = 'EnvironmentError';
    this.issues = issues;
  }
}

/**
 * Fails loudly if server-only configuration is evaluated in a browser bundle.
 *
 * This is the last line of defence, not the first one: the primary guarantee is
 * that server env modules are never imported from client components. Without a
 * runtime check, a bad import would silently ship secrets to the browser.
 */
export const assertServerRuntime = (scope: string): void => {
  // Checked through `globalThis` so this module stays free of DOM lib types.
  if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
    throw new EnvironmentError(scope, [
      'server-only configuration was imported into a client bundle',
    ]);
  }
};

/**
 * Validates an environment map once and returns a frozen, typed snapshot.
 *
 * Configuration is resolved eagerly at module load so a misconfigured process
 * fails at boot rather than on the first request that happens to need a value.
 *
 * @param scope - Name used in error messages, e.g. `'@space/web (server)'`.
 * @param schema - Schema describing the variables this runtime requires.
 * @param source - Environment map to read; defaults to `process.env`.
 */
export const defineEnv = <TSchema extends z.ZodType>(
  scope: string,
  schema: TSchema,
  source: EnvSource = process.env,
): Readonly<z.output<TSchema>> => {
  try {
    return Object.freeze(parseOrThrow(schema, source, scope));
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new EnvironmentError(scope, error.issues);
    }
    throw error;
  }
};
