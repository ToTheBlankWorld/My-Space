'use client';

import { useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '../lib/cn';

export interface SwitchProps extends Omit<
  ComponentPropsWithoutRef<'button'>,
  'onChange' | 'onClick'
> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  label: string;
}

/**
 * A labelled on/off control rendered as `role="switch"`.
 *
 * Prefer the controlled form (`checked` + `onCheckedChange`); an uncontrolled
 * form is available through `defaultChecked` for convenience.
 */
export const Switch = ({
  checked,
  defaultChecked = false,
  onCheckedChange,
  label,
  className,
  ...props
}: SwitchProps) => {
  const [internal, setInternal] = useState(defaultChecked);
  const isChecked = checked ?? internal;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isChecked}
      aria-label={label}
      onClick={() => {
        const next = !isChecked;
        setInternal(next);
        onCheckedChange?.(next);
      }}
      className={cn(
        'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0.5 transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
        isChecked ? 'bg-foreground' : 'bg-border-strong',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'block size-4 rounded-full bg-background shadow-sm transition-transform duration-200',
          isChecked && 'translate-x-4',
        )}
      />
    </button>
  );
};
