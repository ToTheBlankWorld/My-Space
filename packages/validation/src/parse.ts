import type { z } from 'zod';

/** Raised when a value fails schema validation at a system boundary. */
export class ValidationError extends Error {
  public readonly issues: readonly string[];

  constructor(subject: string, issues: readonly string[]) {
    super(`Invalid ${subject}:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/**
 * Renders Zod issues as `path: message` lines.
 *
 * Boundary failures are read in terminals and CI logs, so the output is flat and
 * never includes the offending value — environment input may contain secrets.
 */
export const formatIssues = (error: z.ZodError): string[] =>
  error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });

/**
 * Parses `input` or throws a {@link ValidationError} carrying every issue.
 *
 * @param subject - Human-readable name of what is being parsed, used in the message.
 */
export const parseOrThrow = <TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
  subject: string,
): z.output<TSchema> => {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new ValidationError(subject, formatIssues(result.error));
  }

  return result.data;
};
