import { navigation, site } from '@/lib/site';

export const SiteFooter = () => (
  <footer className="border-t border-border py-12">
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="size-2 rounded-full bg-accent" />
        <p className="text-sm font-medium tracking-[-0.01em]">{site.name}</p>
        <p className="text-sm text-muted-foreground">{site.tagline}</p>
      </div>

      <nav aria-label="Footer" className="flex items-center gap-6">
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

      <p className="text-sm text-muted-foreground tabular-nums">
        &copy; {site.copyrightYear} {site.name}
      </p>
    </div>
  </footer>
);
