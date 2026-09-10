import { Skeleton } from '@space/ui';

import { site } from '@/lib/site';

/**
 * The shell-shaped loading state.
 *
 * Rendered by each authenticated route's `loading.tsx`. It mirrors the app
 * shell's rail so a navigation never flashes a bare page, but reads nothing —
 * it is pure markup, so it streams immediately while the real page waits on its
 * data dependencies.
 */
export const AppLoading = () => {
  const bars = ['Overview', 'Today', 'Notifications', 'Calendar', 'Settings'];

  return (
    <div className="min-h-dvh bg-background">
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-border bg-surface md:flex">
          <div className="flex h-16 items-center gap-2.5 border-b border-border/80 px-5">
            <span aria-hidden className="size-2 rounded-full bg-accent/70" />
            <span className="text-[0.9375rem] font-medium tracking-[-0.01em]">{site.name}</span>
          </div>
          <nav aria-hidden className="flex flex-col gap-1 px-3 py-4">
            {bars.map((label) => (
              <Skeleton key={label} className="h-8 w-full" />
            ))}
          </nav>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 flex h-14 items-center border-b border-border/80 bg-background/80 px-4 backdrop-blur md:hidden">
            <Skeleton aria-hidden className="size-2 rounded-full" />
          </header>

          <main id="main" className="mx-auto w-full max-w-6xl px-4 pt-8 sm:px-6 lg:px-8">
            <div className="flex items-end justify-between border-b border-border/70 pb-6">
              <div className="space-y-3">
                <Skeleton aria-hidden className="h-3 w-24" />
                <Skeleton aria-hidden className="h-9 w-64" />
              </div>
              <Skeleton aria-hidden className="hidden h-10 w-36 sm:block" />
            </div>
            <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="space-y-4">
                <Skeleton aria-hidden className="h-4 w-24" />
                <Skeleton aria-hidden className="h-72 w-full" />
              </div>
              <div className="space-y-4">
                <Skeleton aria-hidden className="h-4 w-16" />
                <Skeleton aria-hidden className="h-40 w-full" />
                <Skeleton aria-hidden className="h-4 w-28" />
                <Skeleton aria-hidden className="h-48 w-full" />
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
};
