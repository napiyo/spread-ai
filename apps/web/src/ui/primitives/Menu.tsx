import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { cn } from '@/lib/cn'
import { spring } from '@/lib/motion'

/**
 * A small dropdown.
 *
 * Hand-rolled rather than pulled from Radix because the only behaviours needed
 * are "close when you click elsewhere" and "close on escape", and a menu
 * primitive is a lot of bundle for two event listeners.
 */
export function Menu({
  trigger,
  align = 'left',
  children,
}: {
  trigger: (open: boolean) => ReactNode
  align?: 'left' | 'right'
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-[8px] border border-line-bright bg-panel/50 px-2.5 py-1 text-[12px] text-dim transition-colors hover:border-mute hover:text-fore"
      >
        {trigger(open)}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={spring.quick}
            className={cn(
              'absolute z-50 mt-1.5 w-[300px] overflow-hidden rounded-[10px] border border-line-bright bg-ink/95 p-1 shadow-2xl backdrop-blur-xl',
              align === 'right' ? 'right-0' : 'left-0',
            )}
          >
            {children(() => setOpen(false))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function MenuItem({
  selected, disabled, title, subtitle, onClick,
}: {
  selected?: boolean
  disabled?: boolean
  title: ReactNode
  subtitle?: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'block w-full rounded-[7px] px-2.5 py-2 text-left transition-colors',
        disabled ? 'cursor-not-allowed opacity-45' : 'hover:bg-panel',
        selected && !disabled && 'bg-panel',
      )}
    >
      <div className={cn('text-[12.5px]', selected ? 'text-cy' : 'text-fore')}>{title}</div>
      {subtitle && <div className="mt-0.5 text-[11px] leading-snug text-mute">{subtitle}</div>}
    </button>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pt-2.5 pb-1 text-[10px] tracking-wide text-mute uppercase">
      {children}
    </div>
  )
}
