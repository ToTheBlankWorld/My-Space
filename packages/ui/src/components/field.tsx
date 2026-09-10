import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '../lib/cn';

const fieldLabel = cva('mb-1.5 block text-[0.8125rem] font-medium text-foreground', {
  variants: {
    required: { true: "after:ml-0.5 after:text-danger after:content-['*']" },
  },
});

export interface FieldLabelProps
  extends ComponentPropsWithoutRef<'label'>, VariantProps<typeof fieldLabel> {}

export const FieldLabel = ({ className, required, ...props }: FieldLabelProps) => (
  <label className={cn(fieldLabel({ required }), className)} {...props} />
);

/** Shared control styling so every field in the product reads as one system. */
export const fieldControlClassName =
  'h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground shadow-none outline-none transition-[color,background-color,border-color,box-shadow] duration-200 placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50';

export type InputProps = ComponentPropsWithoutRef<'input'>;

export const Input = ({ className, ...props }: InputProps) => (
  <input data-slot="input" className={cn(fieldControlClassName, className)} {...props} />
);

export type TextareaProps = ComponentPropsWithoutRef<'textarea'>;

export const Textarea = ({ className, ...props }: TextareaProps) => (
  <textarea
    data-slot="textarea"
    className={cn(fieldControlClassName, 'min-h-24 py-2 leading-relaxed', className)}
    {...props}
  />
);

export type SelectProps = ComponentPropsWithoutRef<'select'>;

export const Select = ({ className, ...props }: SelectProps) => (
  <select
    data-slot="select"
    className={cn(
      fieldControlClassName,
      'appearance-none bg-no-repeat pr-8',
      '[background-image:linear-gradient(45deg,transparent_50%,var(--color-muted-foreground)_50%),linear-gradient(135deg,var(--color-muted-foreground)_50%,transparent_50%)]',
      '[background-position:calc(100%-0.875rem)_55%,calc(100%-0.625rem)_55%]',
      '[background-size:0.3125rem_0.3125rem]',
      className,
    )}
    {...props}
  />
);
