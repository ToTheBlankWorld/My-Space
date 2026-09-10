'use client';

/**
 * Root error boundary.
 *
 * Renders whenever a page throws while loading. An honest, prompt-level fallback
 * with a retry; the reset re-runs the failed request rather than shipping the
 * user back to a dead end.
 */

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

const ErrorPage = ({ reset }: ErrorProps) => (
  <div className="flex min-h-dvh items-center justify-center bg-background px-6">
    <div className="w-full max-w-md text-center">
      <p className="font-mono text-xs tracking-[0.14em] text-muted-foreground uppercase">
        Something went wrong
      </p>
      <h1 className="mt-3 text-2xl font-medium tracking-[-0.02em]">
        This page could not be loaded.
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Try again — your account, plans and settings are untouched.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
      >
        Try again
      </button>
    </div>
  </div>
);

export default ErrorPage;
