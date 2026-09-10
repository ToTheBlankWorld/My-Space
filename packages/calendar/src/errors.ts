/**
 * Domain errors for calendar operations.
 *
 * Every Google API failure is mapped into one of these stable error classes so
 * retry logic, logging and user-facing messages never depend on Google's error
 * format, which changes without notice.
 */

export class CalendarError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CalendarError';
  }
}

/** The OAuth token is invalid, expired, or the user revoked access. */
export class CalendarAuthError extends CalendarError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CalendarAuthError';
  }
}

/** The granted scopes do not include calendar access. */
export class CalendarPermissionError extends CalendarError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CalendarPermissionError';
  }
}

/** Google returned 429 or a transient 5xx. */
export class CalendarRateLimitError extends CalendarError {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options?: { cause?: unknown; retryAfterMs?: number }) {
    super(message, options);
    this.name = 'CalendarRateLimitError';
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/** A network error, timeout, or other transient failure. */
export class CalendarTransientError extends CalendarError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CalendarTransientError';
  }
}

/** The incremental sync token is stale; a full re-sync is required. */
export class CalendarSyncTokenExpiredError extends CalendarError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CalendarSyncTokenExpiredError';
  }
}

/** Calendar data failed validation. */
export class CalendarValidationError extends CalendarError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CalendarValidationError';
  }
}
