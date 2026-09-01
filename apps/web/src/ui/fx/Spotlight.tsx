import { useRef, type ReactNode } from 'react'
import { motion, useMotionTemplate, useMotionValue } from 'motion/react'
import { cn } from '@/lib/cn'

/**
 * Card surface with a soft glow that tracks the cursor. Pointer position is a
 * motion value written straight to CSS, so it never triggers a React render.
 */
export function Spotlight({
  children,
  className,
  radius = 340,
  tint = 'var(--color-vi)',
}: {
  children: ReactNode
  className?: string
  radius?: number
  tint?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const x = useMotionValue(-9999)
  const y = useMotionValue(-9999)

  const background = useMotionTemplate`radial-gradient(${radius}px circle at ${x}px ${y}px, color-mix(in oklab, ${tint} 16%, transparent), transparent 72%)`

  return (
    <div
      ref={ref}
      onPointerMove={(e) => {
        const r = ref.current?.getBoundingClientRect()
        if (!r) return
        x.set(e.clientX - r.left)
        y.set(e.clientY - r.top)
      }}
      onPointerLeave={() => {
        x.set(-9999)
        y.set(-9999)
      }}
      className={cn('group relative overflow-hidden', className)}
    >
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background }}
      />
      {children}
    </div>
  )
}
