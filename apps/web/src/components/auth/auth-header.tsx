import Link from 'next/link';

import { site } from '@/lib/site';

/**
 * The slim header used on the authentication pages.
 *
 * The landing header's navigation is in-page anchors, which have nothing to
 * anchor to on `/login`, `/onboarding` or `/dashboard`. This header exists so
 * those routes still offer a way home without inheriting anchor links that would
 * quietly point at nothing.
 */
export const AuthHeader = () => (
  <header className="border-b border-border/80">
    <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-6 px-6">
      <Link
        href="/"
        className="flex items-center gap-2.5 rounded-sm text-[0.9375rem] font-medium tracking-[-0.01em]"
      >
        <span aria-hidden className="size-2 rounded-full bg-accent" />
        {site.name}
      </Link>
    </div>
  </header>
);
