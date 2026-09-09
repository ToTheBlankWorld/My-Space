import { cn } from '@space/ui';
import type { ReactNode } from 'react';

export interface SectionProps {
  id: string;
  eyebrow: string;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Shared shell for the landing page sections.
 *
 * Every section repeats the same eyebrow / title / description rhythm, so the
 * structure lives in one place and the page cannot drift out of alignment.
 */
export const Section = ({ id, eyebrow, title, description, children, className }: SectionProps) => (
  <section id={id} className={cn('border-t border-border py-20 sm:py-28', className)}>
    <div className="mx-auto w-full max-w-6xl px-6">
      <div className="max-w-2xl">
        <p className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
          {eyebrow}
        </p>
        <h2 className="mt-4 text-3xl font-medium tracking-[-0.02em] text-balance sm:text-4xl">
          {title}
        </h2>
        {description ? (
          <p className="mt-4 text-base leading-relaxed text-muted-foreground sm:text-lg">
            {description}
          </p>
        ) : null}
      </div>
      <div className="mt-12 sm:mt-16">{children}</div>
    </div>
  </section>
);
