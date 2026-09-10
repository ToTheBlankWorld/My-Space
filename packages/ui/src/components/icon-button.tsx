import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '../lib/cn';
import { buttonVariants } from './button';

export type IconButtonProps = ComponentPropsWithoutRef<'button'>;

/** A square button for a single icon action. Primarily for high-density rows. */
export const IconButton = ({ className, ...props }: IconButtonProps) => (
  <button
    data-slot="icon-button"
    type="button"
    className={cn(
      buttonVariants({ variant: 'ghost', size: 'icon' }),
      'size-8 rounded-md transition-[color,background-color,border-color,box-shadow] duration-200 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4',
      className,
    )}
    {...props}
  />
);
