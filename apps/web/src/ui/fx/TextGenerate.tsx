import { motion, useReducedMotion } from 'motion/react'
import { cn } from '@/lib/cn'

/**
 * Reveals a line word by word, the way a model emits it. Used only on the hero
 * headline — anywhere else it would be decoration rather than a reference.
 */
export function TextGenerate({
  text,
  className,
  delay = 0,
  stagger = 0.055,
  gradient = false,
}: {
  text: string
  className?: string
  delay?: number
  stagger?: number
  /**
   * Set when the parent paints a `background-clip: text` gradient. A `filter`
   * on a descendant promotes it to its own layer, which escapes the ancestor's
   * text clip and renders the words invisible — so gradient lines animate with
   * opacity and offset only.
   */
  gradient?: boolean
}) {
  const still = useReducedMotion()
  const words = text.split(' ')

  if (still) return <span className={className}>{text}</span>

  const hidden = gradient
    ? { opacity: 0, y: '0.25em' }
    : { opacity: 0, y: '0.25em', filter: 'blur(10px)' }
  const show = gradient
    ? { opacity: 1, y: 0 }
    : { opacity: 1, y: 0, filter: 'blur(0px)' }

  return (
    <motion.span
      className={cn('inline', className)}
      initial="hidden"
      animate="show"
      variants={{ show: { transition: { delayChildren: delay, staggerChildren: stagger } } }}
      aria-label={text}
    >
      {words.map((w, i) => (
        <motion.span
          key={`${w}-${i}`}
          className="inline-block"
          aria-hidden
          variants={{
            hidden,
            show: { ...show, transition: { duration: 0.65, ease: [0.16, 1, 0.3, 1] } },
          }}
        >
          {w}
          {i < words.length - 1 ? ' ' : ''}
        </motion.span>
      ))}
    </motion.span>
  )
}
