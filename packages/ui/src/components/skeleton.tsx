import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '../lib/cn';

export type SkeletonProps = ComponentPropsWithoutRef<'div'>;

/** A shimmer-free placeholder block. Pulsing respects the global reduced-motion rule. */
export const Skeleton = ({ className, ...props }: SkeletonProps) => (
  <div
    data-slot="skeleton"
    aria-hidden="true"
    className={cn('animate-pulse rounded-md bg-muted', className)}
    {...props}
  />
);
