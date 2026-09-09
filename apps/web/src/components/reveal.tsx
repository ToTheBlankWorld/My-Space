'use client';

import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

export interface RevealProps {
  children: ReactNode;
  className?: string;
  /** Seconds of delay, used to stagger sibling elements. */
  delay?: number;
}

/**
 * Fades content in as it enters the viewport.
 *
 * Motion here is a legibility aid, not decoration: it signals that a section has
 * arrived without competing with the content. Callers who prefer reduced motion
 * get the same layout with no animation at all — the element renders visible
 * rather than waiting for an intersection that never animates.
 */
export const Reveal = ({ children, className, delay = 0 }: RevealProps) => {
  const prefersReducedMotion = useReducedMotion();

  if (prefersReducedMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.5, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
};
