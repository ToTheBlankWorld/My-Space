import { Button } from '@space/ui';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Page not found',
};

const NotFound = () => (
  <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col items-start justify-center gap-6 px-6">
    <p className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">Error 404</p>
    <h1 className="text-3xl font-medium tracking-[-0.02em] sm:text-4xl">
      This page does not exist.
    </h1>
    <p className="max-w-md text-base leading-relaxed text-muted-foreground">
      The address you followed is not part of Space. It may have been moved, or it may not have been
      built yet.
    </p>
    <Button asChild>
      <Link href="/">Back to the start</Link>
    </Button>
  </main>
);

export default NotFound;
