import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '../lib/cn';

export const Card = ({ className, ...props }: ComponentPropsWithoutRef<'section'>) => (
  <section
    data-slot="card"
    className={cn('rounded-xl border border-border bg-surface', className)}
    {...props}
  />
);

export const CardHeader = ({ className, ...props }: ComponentPropsWithoutRef<'header'>) => (
  <header className={cn('flex flex-col gap-1 px-5 pt-4', className)} {...props} />
);

export const CardTitle = ({ className, ...props }: ComponentPropsWithoutRef<'h3'>) => (
  <h3
    className={cn(
      'text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase',
      className,
    )}
    {...props}
  />
);

export const CardContent = ({ className, ...props }: ComponentPropsWithoutRef<'div'>) => (
  <div className={cn('px-5 py-4', className)} {...props} />
);
