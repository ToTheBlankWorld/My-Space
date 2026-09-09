import type { LogLevel } from '@space/types';
import pino from 'pino';
import type { DestinationStream, Logger as PinoLogger } from 'pino';

/**
 * Structured logger used by every server-side runtime.
 *
 * Logs are JSON on stdout: the deployment platforms (Railway, Vercel) collect
 * stdout, and structured records are what a log pipeline can filter on later.
 */
export type Logger = PinoLogger<never, boolean>;

export interface LoggerOptions {
  /** Service or process name attached to every record. */
  name: string;
  level: LogLevel;
  /** Extra fields merged into every record, e.g. a deployment identifier. */
  bindings?: Record<string, string | number | boolean>;
  /** Override the output stream. Intended for tests. */
  destination?: DestinationStream;
}

/**
 * Paths scrubbed from every record.
 *
 * Redaction is centralised rather than left to call sites, because a single
 * forgotten object spread is enough to write a credential into permanent logs.
 */
export const REDACTED_PATHS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
  'authorization',
  'cookie',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.secret',
  'req.headers.authorization',
  'req.headers.cookie',
] as const;

/**
 * Creates a configured logger instance.
 *
 * @example
 * const logger = createLogger({ name: 'space-worker', level: 'info' });
 * logger.info({ jobId }, 'job accepted');
 */
export const createLogger = ({ name, level, bindings, destination }: LoggerOptions): Logger =>
  pino(
    {
      level,
      base: { service: name, ...bindings },
      redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' },
      formatters: {
        // Emit `"level":"info"` instead of pino's default numeric level.
        level: (label) => ({ level: label }),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    // Synchronous writes: the worker exits on SIGTERM, and an async
    // destination can drop the shutdown records that explain why it exited.
    destination ?? pino.destination({ dest: 1, sync: true }),
  );
