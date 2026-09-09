import { Button } from '@space/ui';

import { DASHBOARD_PATH, LOGIN_PATH, getOptionalUser } from '@/server/session';
import { navigation, site } from '@/lib/site';

/**
 * Sticky top navigation.
 *
 * In-page anchors for anonymous visitors; once the visitor has an identity, the
 * header swaps its call to action for a door into the authenticated application.
 * The session is read on the server, so the header never waits on a client
 * round-trip to know what to render.
 */
export const SiteHeader = async () => {
  const session = await getOptionalUser();

  return (
    <header className="sticky top-0 z-40 border-b border-border/80 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-6 px-6">
        <a
          href="#main"
          className="flex items-center gap-2.5 rounded-sm text-[0.9375rem] font-medium tracking-[-0.01em]"
        >
          <span aria-hidden className="size-2 rounded-full bg-accent" />
          {site.name}
        </a>

        <nav aria-label="Primary" className="hidden items-center gap-8 md:flex">
          {navigation.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {item.label}
            </a>
          ))}
        </nav>

        {session ? (
          <Button asChild size="sm">
            <a href={DASHBOARD_PATH}>
              {session.user.name?.trim() ?? 'Open Space'}
              <span aria-hidden>→</span>
            </a>
          </Button>
        ) : (
          <Button asChild size="sm" variant="secondary">
            <a href={LOGIN_PATH}>Sign in</a>
          </Button>
        )}
      </div>
    </header>
  );
};
