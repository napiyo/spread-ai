import { useEffect, useId, useState, type RefObject } from 'react'
import { motion, useReducedMotion } from 'motion/react'

interface Props {
  containerRef: RefObject<HTMLElement | null>
  fromRef: RefObject<HTMLElement | null>
  toRef: RefObject<HTMLElement | null>
  /**
   * How hard traffic is flowing, 0-1. In the fleet graph this is driven by real
   * bytes/sec on the data channel, so a still beam genuinely means an idle link.
   */
  flow?: number
  curvature?: number
  reverse?: boolean
  className?: string
  color?: string
  dashed?: boolean
}

/**
 * Draws a curved beam between two DOM nodes and animates a gradient along it.
 * Geometry is recomputed on resize and on layout changes to either endpoint,
 * so it survives the fleet graph reflowing when a device joins.
 */
export function AnimatedBeam({
  containerRef,
  fromRef,
  toRef,
  flow = 0,
  curvature = 0,
  reverse = false,
  className,
  color = 'var(--color-cy)',
  dashed = false,
}: Props) {
  const id = useId().replace(/:/g, '')
  const [path, setPath] = useState('')
  const [box, setBox] = useState({ w: 0, h: 0 })
  const still = useReducedMotion()

  useEffect(() => {
    const update = () => {
      const c = containerRef.current
      const a = fromRef.current
      const b = toRef.current
      if (!c || !a || !b) return

      const cr = c.getBoundingClientRect()
      const ar = a.getBoundingClientRect()
      const br = b.getBoundingClientRect()
      setBox({ w: cr.width, h: cr.height })

      const x1 = ar.left - cr.left + ar.width / 2
      const y1 = ar.top - cr.top + ar.height / 2
      const x2 = br.left - cr.left + br.width / 2
      const y2 = br.top - cr.top + br.height / 2

      // Bow the curve perpendicular to the line so parallel links between the
      // same pair of nodes stay visually distinct.
      const mx = (x1 + x2) / 2
      const my = (y1 + y2) / 2
      const dx = x2 - x1
      const dy = y2 - y1
      const len = Math.hypot(dx, dy) || 1
      const cx = mx + (-dy / len) * curvature
      const cy = my + (dx / len) * curvature

      setPath(`M ${x1},${y1} Q ${cx},${cy} ${x2},${y2}`)
    }

    update()
    const ro = new ResizeObserver(update)
    for (const el of [containerRef.current, fromRef.current, toRef.current]) if (el) ro.observe(el)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [containerRef, fromRef, toRef, curvature])

  if (!path) return null

  const active = flow > 0.01 && !still
  // Faster traffic pulses faster. Clamped so a saturated link still reads as a
  // beam rather than a strobe.
  const duration = Math.max(0.55, 3.2 - flow * 2.6)

  return (
    <svg
      className={className}
      width={box.w}
      height={box.h}
      viewBox={`0 0 ${box.w} ${box.h}`}
      fill="none"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      aria-hidden
    >
      <path
        d={path}
        stroke="var(--color-line-bright)"
        strokeWidth={1.5}
        strokeOpacity={0.9}
        strokeDasharray={dashed ? '4 6' : undefined}
        strokeLinecap="round"
      />
      {active && (
        <>
          <path d={path} stroke={`url(#beam-${id})`} strokeWidth={2.5} strokeLinecap="round" />
          <defs>
            <motion.linearGradient
              id={`beam-${id}`}
              gradientUnits="userSpaceOnUse"
              initial={{ x1: '0%', x2: '0%', y1: '0%', y2: '0%' }}
              animate={{
                x1: reverse ? [box.w, -box.w * 0.2] : [-box.w * 0.2, box.w],
                x2: reverse ? [box.w * 1.2, 0] : [0, box.w * 1.2],
                y1: [0, 0],
                y2: [0, 0],
              }}
              transition={{ duration, repeat: Infinity, ease: 'linear' }}
            >
              <stop stopColor={color} stopOpacity="0" />
              <stop offset="0.45" stopColor={color} stopOpacity="0.9" />
              <stop offset="0.55" stopColor="var(--color-vi)" stopOpacity="0.9" />
              <stop offset="1" stopColor="var(--color-vi)" stopOpacity="0" />
            </motion.linearGradient>
          </defs>
        </>
      )}
    </svg>
  )
}
