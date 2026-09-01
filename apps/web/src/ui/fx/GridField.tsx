import { cn } from '@/lib/cn'

/** Faint technical grid, faded out toward the edges so it never boxes content in. */
export function GridField({ className, fade = 'radial' }: { className?: string; fade?: 'radial' | 'top' }) {
  const mask =
    fade === 'radial'
      ? 'radial-gradient(ellipse 70% 60% at 50% 30%, black 20%, transparent 75%)'
      : 'linear-gradient(to bottom, black, transparent 70%)'
  return (
    <div
      aria-hidden
      className={cn('grid-field pointer-events-none absolute inset-0', className)}
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    />
  )
}
