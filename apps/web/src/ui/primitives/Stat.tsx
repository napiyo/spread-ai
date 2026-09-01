import type { ReactNode } from 'react'
import { NumberTicker } from '@/ui/fx/NumberTicker'
import { cn } from '@/lib/cn'

/**
 * One measured quantity. `source` is deliberately prominent: a number we
 * measured and a number we guessed must never look alike.
 */
export function Stat({
  label,
  value,
  unit,
  decimals = 0,
  source,
  hint,
  className,
  icon,
}: {
  label: string
  value: number | string
  unit?: string
  decimals?: number
  source?: 'measured' | 'estimated' | 'spec'
  hint?: string
  className?: string
  icon?: ReactNode
}) {
  return (
    <div className={cn('min-w-0', className)} title={hint}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-mute uppercase">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span
          className={cn(
            'text-[26px] leading-none font-semibold tracking-tight',
            source === 'measured' ? 'text-gradient' : 'text-fore',
          )}
        >
          {typeof value === 'number' ? <NumberTicker value={value} decimals={decimals} /> : value}
        </span>
        {unit && <span className="text-[13px] text-mute">{unit}</span>}
      </div>
      {source && (
        <div className="mt-1 text-[10.5px] tracking-wide text-mute/80 uppercase">
          {source === 'measured' ? 'measured here' : source === 'estimated' ? 'estimated' : 'from spec'}
        </div>
      )}
    </div>
  )
}
