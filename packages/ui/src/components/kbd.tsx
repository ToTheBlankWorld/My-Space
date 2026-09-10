import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '../lib/cn';

export type KbdProps = ComponentPropsWithoutRef<'kbd'>;

/** A key hint for a keyboard shortcut. Label stays readable for screen readers. */
export const Kbd = ({ className, ...props }: KbdProps) => (
  <kbd
    data-slot="kbd"
    className={cn(
      'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border-strong bg-muted px-1 font-sans text-[0.6875rem] font-medium text-muted-foreground tabular-nums',
      className,
    )}
    {...props}
  />
);
