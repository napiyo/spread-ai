import NumberFlow, { continuous } from '@number-flow/react'
import { cn } from '@/lib/cn'

/**
 * Animated numeric readout. Used for every measured quantity in the app, so a
 * value visibly *moving* always means it was just measured or recalculated.
 *
 * NumberFlow renders its digits entirely inside shadow DOM and exposes neither
 * text nor an aria-label, so on its own the number reaches no screen reader and
 * no text extraction at all. Since the numbers are the entire point of this
 * app, the value is also emitted as visually-hidden text and the animated
 * element is hidden from the accessibility tree.
 */
export function NumberTicker({
  value,
  suffix,
  prefix,
  decimals = 0,
  className,
}: {
  value: number
  suffix?: string
  prefix?: string
  decimals?: number
  className?: string
}) {
  const safe = Number.isFinite(value) ? value : 0
  const format = {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  } as const
  const spoken = `${prefix ?? ''}${safe.toLocaleString(undefined, format)}${suffix ?? ''}`

  return (
    <span className={cn('tabular-nums', className)}>
      <span className="sr-only">{spoken}</span>
      <span aria-hidden="true">
        <NumberFlow
          value={safe}
          plugins={[continuous]}
          format={format}
          prefix={prefix}
          suffix={suffix}
          willChange
        />
      </span>
    </span>
  )
}
