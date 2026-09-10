/**
 * Structured errors for the plan-my-day application service.
 *
 * Each error carries a stable machine-readable `code` so an API boundary can map
 * it to an HTTP status without parsing messages, and the messages themselves
 * never include database internals, stack frames or user data beyond identifiers.
 */

export type PlanErrorCode =
  | 'SPACE_NOT_FOUND'
  | 'PLAN_VERSION_CONFLICT'
  | 'INVALID_DATE'
  | 'PLANNING_CONFLICT'
  | 'PLANNING_FAILED';

export interface PlanServiceError extends Error {
  readonly code: PlanErrorCode;
}

/** The date is not a well-formed `YYYY-MM-DD` calendar date. */
export class PlanInvalidDateError extends Error implements PlanServiceError {
  readonly code = 'INVALID_DATE' as const;

  constructor(value: unknown) {
    super(`Invalid calendar date "${String(value)}"; expected YYYY-MM-DD.`);
    this.name = 'PlanInvalidDateError';
  }
}

/**
 * The space could not be resolved for planning. With lazy space creation this
 * is nearly unreachable, but the API model is complete either way: a space the
 * caller cannot see is deliberately indistinct from one that does not exist.
 */
export class PlanSpaceNotFoundError extends Error implements PlanServiceError {
  readonly code = 'SPACE_NOT_FOUND' as const;

  constructor() {
    super('The space could not be found.');
    this.name = 'PlanSpaceNotFoundError';
  }
}

/**
 * Someone else changed the space between loading its snapshot and persisting the
 * result. The pass was deliberately abandoned rather than clobbering newer
 * state — this is the optimistic-concurrency signal.
 */
export class PlanVersionConflictError extends Error implements PlanServiceError {
  readonly code = 'PLAN_VERSION_CONFLICT' as const;

  constructor() {
    super('The space changed while the plan was being computed; no changes were written.');
    this.name = 'PlanVersionConflictError';
  }
}

/** The loaded snapshot violates engine invariants; no plan can be produced. */
export class PlanInputInvalidError extends Error implements PlanServiceError {
  readonly code = 'PLANNING_CONFLICT' as const;

  constructor(violations: readonly string[]) {
    super(`The day state conflicts with planning rules: ${violations.join('; ')}`);
    this.name = 'PlanInputInvalidError';
  }
}

/** An internal failure while planning. Details stay server-side. */
export class PlanFailedError extends Error implements PlanServiceError {
  readonly code = 'PLANNING_FAILED' as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PlanFailedError';
  }
}

export const isPlanServiceError = (value: unknown): value is PlanServiceError =>
  value instanceof Error && typeof (value as PlanServiceError).code === 'string';
