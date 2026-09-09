import { timingSafeEqual } from 'node:crypto';

/**
 * The deterministic end-to-end sign-in.
 *
 * Real OAuth cannot be exercised by a test runner: signing in through Google
 * needs a human-shaped consent screen, and a headless browser cannot complete
 * it. The whole authentication surface would therefore ship untested unless a
 * test-only way to obtain a session exists.
 *
 * This module is that way, and it is built so that it *cannot* be enabled in
 * production:
 *
 * 1. `E2E_AUTH_ENABLED` is only honoured when `NODE_ENV` is not `production`
 *    (the `@space/config/auth` schema makes a production process with the flag
 *    set fail to boot);
 * 2. the endpoint refuses to run unless `isE2EAuthAllowed` returns true;
 * 3. the test client must present `E2E_AUTH_SECRET`, compared in constant
 *    time, so an attacker who reaches a mis-configured deployment still cannot
 *    obtain a session without the secret.
 *
 * The credentials are fixed: `e2e@space.test`. The test runner signs in as this
 * account only, and the route resets `onboardingCompletedAt` on every call so a
 * re-run always exercises the full login → onboarding → dashboard flow. This
 * account must never be given calendar access or any other real capability.
 */

/** The fixed test identity. Never signable except through the E2E route. */
export const E2E_USER_EMAIL = 'e2e@space.test';
export const E2E_USER_NAME = 'Space Test User';

/** The decision the route is allowed to run. */
export interface E2EAuthAllowance {
  readonly enabled: boolean;
  /** The environment name; `production` is always refused. */
  readonly nodeEnv: string;
  /** Shared secret the test client must present. `undefined` means unset. */
  readonly secret: string | undefined;
}

/** Raised when the deterministic sign-in route is invoked but must not run. */
export class E2EAuthDisabledError extends Error {
  constructor() {
    super('The deterministic end-to-end sign-in route is disabled.');
    this.name = 'E2EAuthDisabledError';
  }
}

/**
 * True only when the route may not just exist but also be reached.
 *
 * All three conditions must hold: the flag is on, the environment is not
 * production, and a secret is configured. The environment schema additionally
 * refuses the flagon when `NODE_ENV=production`, so `nodeEnv` is the last line,
 * not the first.
 */
export const isE2EAuthAllowed = (allowance: E2EAuthAllowance): boolean =>
  allowance.enabled && allowance.nodeEnv !== 'production' && allowance.secret !== undefined;

/** Throws {@link E2EAuthDisabledError} unless the route is allowed to run. */
export const assertE2EAuthAllowed = (allowance: E2EAuthAllowance): void => {
  if (!allowance.enabled) {
    throw new E2EAuthDisabledError();
  }
  if (allowance.nodeEnv === 'production') {
    throw new E2EAuthDisabledError();
  }
  if (allowance.secret === undefined) {
    throw new E2EAuthDisabledError();
  }
};

/**
 * Constant-time comparison of the presented secret against the configured one.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the
 * secret's length; comparing lengths first is the accepted trade-off and the
 * measurable cost is negligible for a 32+ character secret.
 */
export const e2eSecretMatches = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  return a.length === b.length && timingSafeEqual(a, b);
};
