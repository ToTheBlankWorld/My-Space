import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names and resolves conflicting Tailwind utilities.
 *
 * Without the merge step, a caller's `px-6` would sit alongside a component's
 * `px-4` and the winner would depend on stylesheet order rather than intent.
 */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
