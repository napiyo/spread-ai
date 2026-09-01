import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Tone = 'neutral' | 'live' | 'warn' | 'bad' | 'good'

const TONES: Record<Tone, string> = {
  neutral: 'border-line-bright text-dim',
  live: 'border-cy/35 text-cy bg-cy/[0.06]',
  good: 'border-lime/35 text-lime bg-lime/[0.06]',
  warn: 'border-amber/35 text-amber bg-amber/[0.06]',
  bad: 'border-rose/35 text-rose bg-rose/[0.06]',
}

export function Chip({
  tone = 'neutral',
  icon,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; icon?: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium tracking-tight',
        TONES[tone],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </span>
  )
}

/** A dot that pulses only while something is genuinely happening. */
export function LiveDot({ active = true, tone = 'var(--color-lime)' }: { active?: boolean; tone?: string }) {
  return (
    <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
      {active && (
        <span
          className="absolute inset-0 rounded-full"
          style={{ background: tone, animation: 'sai-pulse-ring 1.8s ease-out infinite' }}
        />
      )}
      <span
        className="relative inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: active ? tone : 'var(--color-line-bright)' }}
      />
    </span>
  )
}
