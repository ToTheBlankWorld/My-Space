import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cn } from '../lib/cn';

export interface EmptyStateProps extends ComponentPropsWithoutRef<'div'> {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

/** A calm, purposeful placeholder for "nothing here yet". */
export const EmptyState = ({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) => (
  <div
    data-slot="empty-state"
    className={cn('flex flex-col items-center gap-2 px-6 py-10 text-center', className)}
    {...props}
  >
    {icon ? (
      <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </div>
    ) : null}
    <p className="text-sm font-medium text-foreground">{title}</p>
    {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
    {action ? <div className="mt-3">{action}</div> : null}
  </div>
);
