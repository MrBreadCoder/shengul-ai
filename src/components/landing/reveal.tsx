'use client'

import type { ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { LANDING_EASE, REVEAL_DURATION_MS } from './constants'

interface RevealProps {
  children: ReactNode
  /** Seconds of stagger offset. Used to sequence siblings, never above ~0.3s. */
  delay?: number
  className?: string
}

/**
 * Scroll-entry animation for a block of marketing content. Transform and
 * opacity only, so it stays on the compositor. Under `prefers-reduced-motion`
 * the content renders statically instead of animating in — the wrapper still
 * emits the same DOM, so layout never depends on the motion path.
 */
export function Reveal({ children, delay = 0, className }: RevealProps): React.ReactElement {
  const prefersReducedMotion = useReducedMotion()

  if (prefersReducedMotion) return <div className={className}>{children}</div>

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: REVEAL_DURATION_MS / 1000, delay, ease: LANDING_EASE }}
    >
      {children}
    </motion.div>
  )
}
