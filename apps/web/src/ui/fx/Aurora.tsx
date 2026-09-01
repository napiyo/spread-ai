import { useReducedMotion } from 'motion/react'
import { cn } from '@/lib/cn'

/**
 * Slow drifting colour field behind the hero. Two blurred radial blobs on a
 * long, offset loop so the motion never reads as a repeating cycle.
 */
export function Aurora({ className, intensity = 1 }: { className?: string; intensity?: number }) {
  const still = useReducedMotion()
  return (
    <div className={cn('sai-decor pointer-events-none absolute inset-0 overflow-hidden', className)} aria-hidden>
      <div
        className="absolute -top-1/3 left-1/2 h-[70vmax] w-[70vmax] -translate-x-1/2 rounded-full blur-[120px]"
        style={{
          background:
            'radial-gradient(circle at 30% 30%, color-mix(in oklab, var(--color-vi) 55%, transparent), transparent 62%)',
          opacity: 0.4 * intensity,
          animation: still ? undefined : 'sai-drift-a 26s ease-in-out infinite alternate',
        }}
      />
      <div
        className="absolute top-0 left-1/4 h-[55vmax] w-[55vmax] rounded-full blur-[130px]"
        style={{
          background:
            'radial-gradient(circle at 60% 40%, color-mix(in oklab, var(--color-cy) 45%, transparent), transparent 60%)',
          opacity: 0.32 * intensity,
          animation: still ? undefined : 'sai-drift-b 34s ease-in-out infinite alternate',
        }}
      />
      <style>{`
        @keyframes sai-drift-a {
          0%   { transform: translate(-50%, 0) scale(1); }
          100% { transform: translate(-38%, 6%) scale(1.15); }
        }
        @keyframes sai-drift-b {
          0%   { transform: translate(0, 0) scale(1.1); }
          100% { transform: translate(14%, -8%) scale(0.92); }
        }
      `}</style>
    </div>
  )
}
