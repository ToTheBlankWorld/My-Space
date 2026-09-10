import { isPlanServiceError } from './errors';

/**
 * Maps a plan-service error to the HTTP status an API boundary should return.
 *
 * Kept in the package so it is unit-testable without a web harness; the route
 * handler uses it instead of re-implementing the table.
 */
export const planErrorHttpStatus = (error: unknown): number => {
  if (!isPlanServiceError(error)) {
    return 500;
  }

  switch (error.code) {
    case 'SPACE_NOT_FOUND':
      return 404;
    case 'PLAN_VERSION_CONFLICT':
      return 409;
    case 'INVALID_DATE':
      return 400;
    case 'PLANNING_CONFLICT':
      return 422;
    case 'PLANNING_FAILED':
      return 500;
  }
};
