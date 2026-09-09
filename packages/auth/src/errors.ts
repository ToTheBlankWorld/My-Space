/**
 * Authentication and authorisation failures.
 *
 * Separate types because the correct response differs: a missing session is a
 * redirect to sign in, an incomplete onboarding is a redirect into onboarding,
 * and a forbidden resource is a refusal. Collapsing them into one error would
 * make every call site guess.
 */

export class AuthenticationRequiredError extends Error {
  constructor() {
    super('Authentication is required.');
    this.name = 'AuthenticationRequiredError';
  }
}

export class OnboardingRequiredError extends Error {
  constructor() {
    super('Onboarding must be completed first.');
    this.name = 'OnboardingRequiredError';
  }
}

/**
 * The caller is authenticated but may not touch this resource.
 *
 * Deliberately says nothing about whether the resource exists: distinguishing
 * "not yours" from "not there" lets a caller enumerate other users' identifiers.
 */
export class ForbiddenError extends Error {
  constructor(resource = 'resource') {
    super(`Not found or not accessible: ${resource}.`);
    this.name = 'ForbiddenError';
  }
}
