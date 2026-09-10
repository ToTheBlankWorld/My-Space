import Link from 'next/link';

/**
 * Root not-found page.
 *
 * Catches unknown routes and invalid day lookups (a `/space/[date]` value that
 * is not a calendar date), giving every dead end the same quiet exit.
 */
const NotFoundPage = () => (
  <div className="flex min-h-dvh items-center justify-center bg-background px-6">
    <div className="w-full max-w-md text-center">
      <p className="font-mono text-xs tracking-[0.14em] text-muted-foreground uppercase">404</p>
      <h1 className="mt-3 text-2xl font-medium tracking-[-0.02em]">This page does not exist.</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        The address may be wrong, or the day may not be in your calendar.
      </p>
      <Link
        href="/dashboard"
        className="mt-6 inline-block rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
      >
        Back to the overview
      </Link>
    </div>
  </div>
);

export default NotFoundPage;
