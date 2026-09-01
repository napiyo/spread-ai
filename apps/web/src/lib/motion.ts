import type { Transition } from 'motion/react'

/**
 * One spring vocabulary for the whole app. Components pick a name, never a
 * number, so the motion reads as a single system.
 */
export const spring = {
  /** Snappy — buttons, chips, hover states. */
  quick: { type: 'spring', stiffness: 520, damping: 34, mass: 0.7 },
  /** Default — panels, cards, layout shifts. */
  soft: { type: 'spring', stiffness: 260, damping: 30, mass: 0.9 },
  /** Heavy — shared-element transitions between scenes. */
  glide: { type: 'spring', stiffness: 150, damping: 26, mass: 1.1 },
} satisfies Record<string, Transition>

export const ease = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const

/** Staggered reveal used by every list of cards/chips in the app. */
export const stagger = (delayChildren = 0, staggerChildren = 0.045) => ({
  hidden: {},
  show: { transition: { delayChildren, staggerChildren } },
})

export const riseIn = {
  hidden: { opacity: 0, y: 12, filter: 'blur(6px)' },
  show: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.5, ease: ease.out },
  },
}
