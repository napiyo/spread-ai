import { motion } from 'motion/react'
import { navigate, useRoute, type Route } from '@/lib/router'
import { cn } from '@/lib/cn'
import { useDevice } from '@/store/device'
import { LiveDot } from '@/ui/primitives/Chip'
import { spring } from '@/lib/motion'

const TABS: { route: Route; label: string }[] = [
  { route: 'models', label: 'Models' },
  { route: 'advisor', label: 'Advisor' },
  { route: 'fleet', label: 'Fleet' },
  { route: 'chat', label: 'Chat' },
]

export function Nav() {
  const route = useRoute()
  const cap = useDevice((s) => s.capability)

  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-void/70 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-1 px-6">
        <button
          onClick={() => navigate('home')}
          className="mr-4 flex items-center gap-2 text-[15px] font-semibold tracking-tight"
        >
          <Mark />
          spread<span className="text-gradient">AI</span>
        </button>

        <nav className="flex items-center gap-0.5">
          {TABS.map((t) => {
            const active = route === t.route
            return (
              <button
                key={t.route}
                onClick={() => navigate(t.route)}
                className={cn(
                  'relative rounded-[8px] px-3 py-1.5 text-[13.5px] transition-colors',
                  active ? 'text-fore' : 'text-mute hover:text-dim',
                )}
              >
                {active && (
                  <motion.span
                    layoutId="nav-pill"
                    className="absolute inset-0 rounded-[8px] bg-panel"
                    transition={spring.quick}
                  />
                )}
                <span className="relative">{t.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 text-[12px] text-mute">
          <LiveDot active={Boolean(cap?.hasWebGpu)} tone={cap?.hasWebGpu ? 'var(--color-lime)' : 'var(--color-rose)'} />
          <span className="hidden max-w-[220px] truncate sm:inline">
            {cap?.label ?? 'probing…'}
          </span>
        </div>
      </div>
    </header>
  )
}

function Mark() {
  return (
    <svg width="18" height="18" viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="nav-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--color-cy)" />
          <stop offset="1" stopColor="var(--color-vi)" />
        </linearGradient>
      </defs>
      <g stroke="url(#nav-mark)" strokeWidth="3" fill="none" strokeLinecap="round">
        <path d="M32 20 L18 40 M32 20 L46 40 M18 40 L46 40" />
      </g>
      <g fill="url(#nav-mark)">
        <circle cx="32" cy="20" r="5.5" />
        <circle cx="18" cy="40" r="5.5" />
        <circle cx="46" cy="40" r="5.5" />
      </g>
    </svg>
  )
}
