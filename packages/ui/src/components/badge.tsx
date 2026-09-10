import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '../lib/cn';

export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        neutral: 'border border-border bg-muted text-muted-foreground',
        accent: 'bg-accent/12 text-foreground ring-1 ring-accent/25 ring-inset',
        success: 'bg-success/12 text-foreground ring-1 ring-success/30 ring-inset',
        warning: 'bg-warning/12 text-foreground ring-1 ring-warning/30 ring-inset',
        danger: 'bg-danger/12 text-foreground ring-1 ring-danger/30 ring-inset',
        outline: 'border border-border-strong text-foreground',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
);

export type BadgeVariant = VariantProps<typeof badgeVariants>['variant'];

export interface BadgeProps
  extends ComponentPropsWithoutRef<'span'>, VariantProps<typeof badgeVariants> {
  asChild?: boolean;
}

/** A compact status readout. Prefer a `StatusDot` when colour is the only signal. */
export const Badge = ({ className, variant, asChild = false, ...props }: BadgeProps) => {
  const Component = asChild ? Slot : 'span';

  return (
    <Component data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
};

export type StatusTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const dotVariants = cva('inline-block size-1.5 shrink-0 rounded-full bg-current', {
  variants: {
    tone: {
      neutral: 'text-muted-foreground',
      accent: 'text-accent',
      success: 'text-success',
      warning: 'text-warning',
      danger: 'text-danger',
    },
  },
  defaultVariants: {
    tone: 'neutral',
  },
});

export interface StatusDotProps {
  tone: StatusTone;
  className?: string;
  label?: string;
}

/**
 * A colour-only status glyph. Always pair with a text label when the signal is
 * not also conveyed another way (the component's `label` sets an accessible
 * name for assistive technology without rendering visible text).
 */
export const StatusDot = ({ tone, className, label }: StatusDotProps) => (
  <span className={cn('inline-flex', className)}>
    <span aria-hidden="true" className={dotVariants({ tone })} />
    {label ? <span className="sr-only">{label}</span> : null}
  </span>
);
