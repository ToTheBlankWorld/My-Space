/**
 * Severity vocabulary shared by every runtime.
 *
 * It lives in `@space/types` so that the logger implementation and the
 * environment schemas that configure it agree without depending on each other.
 * Ordered from most to least verbose.
 */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
