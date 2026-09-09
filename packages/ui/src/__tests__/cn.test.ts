import { describe, expect, it } from 'vitest';

import { cn } from '../lib/cn';

describe('cn', () => {
  it('joins class names', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('lets the later Tailwind utility win over an earlier conflicting one', () => {
    expect(cn('px-4', 'px-6')).toBe('px-6');
  });

  it('ignores falsy values and flattens conditionals', () => {
    const isActive = false;

    expect(cn('a', isActive && 'b', undefined, ['c', null])).toBe('a c');
  });
});
