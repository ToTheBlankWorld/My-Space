import { Button } from '@space/ui';
import { ArrowRight } from 'lucide-react';

import { Reveal } from '@/components/reveal';
import { site } from '@/lib/site';

const signals = [
  { label: 'Source of truth', value: 'Space' },
  { label: 'Scheduling', value: 'Deterministic' },
  { label: 'Calendar', value: 'Two-way sync' },
] as const;

export const Hero = () => (
  <section className="relative overflow-hidden">
    {/* A single, very low-contrast wash. Depth without a gradient-heavy look. */}
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-[36rem] bg-[radial-gradient(60%_50%_at_50%_0%,color-mix(in_oklab,var(--color-accent)_9%,transparent),transparent_70%)]"
    />

    <div className="relative mx-auto w-full max-w-6xl px-6 pt-20 pb-20 sm:pt-28 sm:pb-28">
      <Reveal className="max-w-3xl">
        <p className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 font-mono text-xs tracking-[0.14em] text-muted-foreground uppercase">
          <span aria-hidden className="size-1.5 rounded-full bg-accent" />
          Stage 03 — Identity
        </p>

        <h1 className="mt-8 text-4xl font-medium tracking-[-0.035em] text-balance sm:text-5xl lg:text-[3.75rem] lg:leading-[1.02]">
          Everything you have to do, resolved into one day you can trust.
        </h1>

        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
          {site.description}
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-3">
          <Button asChild size="lg">
            <a href="#overview">
              See how it works
              <ArrowRight aria-hidden />
            </a>
          </Button>
          <Button asChild size="lg" variant="secondary">
            <a href="#engine">Read the engine model</a>
          </Button>
        </div>
      </Reveal>

      <Reveal delay={0.12}>
        <dl className="mt-16 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
          {signals.map((signal) => (
            <div key={signal.label} className="bg-surface px-6 py-5">
              <dt className="font-mono text-[0.6875rem] tracking-[0.16em] text-muted-foreground uppercase">
                {signal.label}
              </dt>
              <dd className="mt-2 text-lg font-medium tracking-[-0.01em]">{signal.value}</dd>
            </div>
          ))}
        </dl>
      </Reveal>
    </div>
  </section>
);
