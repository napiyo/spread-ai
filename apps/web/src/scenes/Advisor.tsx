import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Check, ChevronRight, Laptop, Minus, Monitor, Plus, Smartphone, Tablet,
  TriangleAlert, X, Zap,
} from 'lucide-react'
import { GridField } from '@/ui/fx/GridField'
import { Spotlight } from '@/ui/fx/Spotlight'
import { NumberTicker } from '@/ui/fx/NumberTicker'
import { Button } from '@/ui/primitives/Button'
import { Chip } from '@/ui/primitives/Chip'
import { DEVICE_DB, DEVICE_GROUPS } from '@/capability/deviceDb'
import { useFleet, useFleetMembers } from '@/store/fleet'
import { useDevice } from '@/store/device'
import { useCatalog, toLoadable } from '@/store/catalog'
import { useEngine } from '@/store/engine'
import { optionsMeetingTarget, recommendModels, type FleetOption } from '@/planner/recommend'
import type { ModelSpec } from '@/planner/modelSpec'
import { bytes, ms } from '@/lib/format'
import { riseIn, spring, stagger } from '@/lib/motion'
import { navigate } from '@/lib/router'
import { cn } from '@/lib/cn'

const KIND_ICON = { phone: Smartphone, tablet: Tablet, laptop: Laptop, desktop: Monitor }

export function Advisor() {
  const [mode, setMode] = useState<'run' | 'target'>('run')
  const deviceInit = useDevice((s) => s.init)
  const catalogInit = useCatalog((s) => s.init)

  useEffect(() => {
    void deviceInit()
    catalogInit()
  }, [deviceInit, catalogInit])

  return (
    <div className="relative min-h-dvh">
      <GridField fade="top" className="opacity-50" />
      <div className="relative mx-auto max-w-6xl px-6 py-14">
        <h1 className="text-[34px] leading-tight font-semibold tracking-[-0.03em]">
          What can your devices run?
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-dim">
          We measured the device you're on. Tell us what else you own and we'll work out what the
          whole set can do — including when the honest answer is that another device won't help.
        </p>

        <FleetPicker />

        <div className="mt-12 flex gap-1 border-b border-line">
          {(
            [
              ['run', 'What can I run?'],
              ['target', 'I want a specific speed'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setMode(id)}
              className={cn(
                'relative px-3 pb-3 text-[13.5px] transition-colors',
                mode === id ? 'text-fore' : 'text-mute hover:text-dim',
              )}
            >
              {label}
              {mode === id && (
                <motion.span
                  layoutId="advisor-tab"
                  className="absolute right-0 -bottom-px left-0 h-px bg-cy"
                  transition={spring.quick}
                />
              )}
            </button>
          ))}
        </div>

        <div className="mt-8">{mode === 'run' ? <WhatCanIRun /> : <TargetSolver />}</div>
      </div>
    </div>
  )
}

/* ── Fleet picker ─────────────────────────────────────────────────────── */

function FleetPicker() {
  const members = useFleetMembers()
  const { declared, add, setCount, clear } = useFleet()
  const [open, setOpen] = useState(false)
  const here = members.find((m) => m.isThisDevice)

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-center gap-2">
        {here && (
          <Chip tone="live" icon={<Check size={11} />}>
            {here.cap.label} · {here.cap.source === 'measured' ? 'measured' : 'detected'}
          </Chip>
        )}
        {declared.map((d) => {
          const spec = DEVICE_DB.find((s) => s.id === d.specId)!
          const Icon = KIND_ICON[spec.kind]
          return (
            <motion.span
              key={d.key}
              layout
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={spring.quick}
              className="inline-flex items-center gap-1.5 rounded-full border border-line-bright bg-panel/50 py-1 pr-1 pl-2.5 text-[11.5px]"
            >
              <Icon size={11} className="text-mute" />
              <span className="text-dim">{spec.label}</span>
              <span className="flex items-center gap-0.5 rounded-full bg-void/60 px-1">
                <button
                  aria-label={`One fewer ${spec.label}`}
                  onClick={() => setCount(d.key, d.count - 1)}
                  className="p-0.5 text-mute hover:text-fore"
                >
                  <Minus size={10} />
                </button>
                <span className="w-3 text-center tabular-nums">{d.count}</span>
                <button
                  aria-label={`One more ${spec.label}`}
                  onClick={() => setCount(d.key, d.count + 1)}
                  className="p-0.5 text-mute hover:text-fore"
                >
                  <Plus size={10} />
                </button>
              </span>
            </motion.span>
          )
        })}

        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          <Plus size={13} /> {declared.length ? 'Add another' : 'What else do you have?'}
        </Button>
        {declared.length > 0 && (
          <Button size="sm" variant="ghost" onClick={clear}>
            Clear
          </Button>
        )}
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring.soft}
            className="overflow-hidden"
          >
            <div className="mt-4 rounded-lg border border-line bg-panel/40 p-4">
              <div className="flex items-start justify-between">
                <p className="max-w-lg text-[12.5px] leading-relaxed text-mute">
                  These are projected from published specifications, not measured. They're good
                  enough to compare options; the device you're on is the one with real numbers.
                </p>
                <button onClick={() => setOpen(false)} className="text-mute hover:text-fore">
                  <X size={15} />
                </button>
              </div>
              <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                {DEVICE_GROUPS.map((g) => (
                  <div key={g.kind}>
                    <div className="text-[10.5px] tracking-wide text-mute uppercase">{g.label}</div>
                    <div className="mt-2 space-y-1">
                      {DEVICE_DB.filter((d) => d.kind === g.kind).map((spec) => (
                        <button
                          key={spec.id}
                          onClick={() => add(spec.id)}
                          className="flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[12.5px] text-dim transition-colors hover:bg-panel hover:text-fore"
                        >
                          <span className="min-w-0 flex-1 truncate">{spec.label}</span>
                          <span className="shrink-0 text-[10.5px] text-mute">
                            {spec.bandwidthGBs} GB/s
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ── Which models can I run ───────────────────────────────────────────── */

function useSpecs(): { spec: ModelSpec; entryId: string }[] {
  const featured = useCatalog((s) => s.featured)
  const specs = useCatalog((s) => s.specs)
  return useMemo(
    () =>
      featured
        .map((e) => (specs[e.id] ? { spec: specs[e.id], entryId: e.id } : null))
        .filter((x): x is { spec: ModelSpec; entryId: string } => Boolean(x)),
    [featured, specs],
  )
}

function WhatCanIRun() {
  const members = useFleetMembers()
  const models = useSpecs()
  const featured = useCatalog((s) => s.featured)
  const catalogSpecs = useCatalog((s) => s.specs)
  const { load } = useEngine()

  const rows = useMemo(
    () => recommendModels(models.map((m) => m.spec), members.map((m) => m.cap), { ctx: 2048 }),
    [models, members],
  )

  if (!rows.length) {
    return <p className="text-[13.5px] text-mute">Reading model architectures…</p>
  }

  // "Runs on what you have" must mean exactly that. `best` falls back to a
  // configuration built from hardware you don't own, which belongs in the other
  // section with the shopping list attached.
  const runnable = rows.filter((r) => r.best?.feasible && r.best.usesOnlyOwned)
  const needsMore = rows.filter((r) => !(r.best?.feasible && r.best.usesOnlyOwned))

  return (
    <motion.div initial="hidden" animate="show" variants={stagger(0, 0.05)} className="space-y-8">
      <section>
        <SectionHead
          title={`${runnable.length} of ${rows.length} run on what you have`}
          note="Ordered by capability — the largest model your fleet can actually hold comes first."
        />
        <div className="mt-4 space-y-2">
          {runnable.map((r) => (
            <motion.div key={r.model.id} variants={riseIn}>
              <RecommendationRow
                model={r.model}
                option={r.best!}
                onLoad={() => {
                  const entry = featured.find((e) => e.id === r.model.id)
                  if (entry) {
                    void load(toLoadable(entry, catalogSpecs[entry.id])).then(() => navigate('chat'))
                  }
                }}
              />
            </motion.div>
          ))}
        </div>
      </section>

      {needsMore.length > 0 && (
        <section>
          <SectionHead
            title="These need hardware you haven't told us about"
            note="The smallest addition that would make each one work."
          />
          <div className="mt-4 space-y-2">
            {needsMore.map((r) => (
              <motion.div key={r.model.id} variants={riseIn}>
                <RecommendationRow
                  model={r.model}
                  option={r.cheapest}
                  blockers={r.ownedBlockers}
                />
              </motion.div>
            ))}
          </div>
        </section>
      )}
    </motion.div>
  )
}

function SectionHead({ title, note }: { title: string; note: string }) {
  return (
    <div>
      <h2 className="text-[15px] font-medium tracking-tight">{title}</h2>
      <p className="mt-1 text-[12.5px] text-mute">{note}</p>
    </div>
  )
}

function RecommendationRow({
  model, option, onLoad, blockers,
}: {
  model: ModelSpec
  option: FleetOption | null
  onLoad?: () => void
  /** Why your own hardware can't do it — shown before any shopping advice. */
  blockers?: string[]
}) {
  const [open, setOpen] = useState(false)

  return (
    <Spotlight
      className="panel rounded-md"
      tint={option?.feasible ? 'var(--color-vi)' : 'var(--color-rose)'}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-4 px-4 py-3.5 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium">{model.label}</span>
            <span className="shrink-0 text-[11.5px] text-mute">
              {model.nLayers} layers · {bytes(model.params * 0.5625)}
            </span>
          </div>
          <div className="mt-1 truncate text-[12.5px] text-mute">
            {blockers?.length
              ? blockers[0]
              : option
                ? option.headline
                : 'No arrangement works'}
          </div>
        </div>

        {option?.feasible ? (
          <div className="shrink-0 text-right">
            <div
              className={cn(
                'text-[17px] leading-none font-semibold',
                blockers?.length ? 'text-dim' : 'text-gradient',
              )}
            >
              <NumberTicker value={option.tokensPerSec} decimals={0} />
              <span className="ml-1 text-[11px] font-normal text-mute">tok/s</span>
            </div>
            <div className="mt-1 text-[10.5px] text-mute">
              {blockers?.length ? `with ${option.headline}` : `first token ${ms(option.ttftMs)}`}
            </div>
          </div>
        ) : (
          <Chip tone="bad">no way to run it</Chip>
        )}

        <ChevronRight
          size={15}
          className={cn('shrink-0 text-mute transition-transform', open && 'rotate-90')}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring.soft}
            className="overflow-hidden"
          >
            <div className="border-t border-line px-4 py-4">
              {blockers && blockers.length > 0 && (
                <div className="mb-4">
                  <div className="text-[10.5px] tracking-wide text-mute uppercase">
                    Why your own devices can't
                  </div>
                  <ul className="mt-2 space-y-1.5">
                    {blockers.map((b) => (
                      <li key={b} className="flex gap-2 text-[12.5px] leading-relaxed text-rose/85">
                        <TriangleAlert size={12} className="mt-[3px] shrink-0" />
                        {b}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {option && <OptionDetail option={option} model={model} />}
              {onLoad && option?.feasible && option.usesOnlyOwned && (
                <Button size="sm" variant="primary" className="mt-4" onClick={onLoad}>
                  Load it
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Spotlight>
  )
}

function OptionDetail({ option, model }: { option: FleetOption; model: ModelSpec }) {
  return (
    <div>
      <p className="text-[13px] leading-relaxed text-dim">{option.why}</p>

      {option.partition && option.partition.stages.length > 1 && (
        <div className="mt-4">
          <div className="text-[10.5px] tracking-wide text-mute uppercase">Layer assignment</div>
          <div className="mt-2 flex h-7 overflow-hidden rounded-[6px] border border-line">
            {option.partition.stages.map((s, i) => (
              <div
                key={s.deviceId + i}
                className="flex items-center justify-center border-r border-line/60 text-[10.5px] text-void last:border-r-0"
                style={{
                  width: `${((s.layerEnd - s.layerStart) / model.nLayers) * 100}%`,
                  background: `linear-gradient(180deg, color-mix(in oklab, var(--color-cy) ${70 - i * 12}%, var(--color-vi)), color-mix(in oklab, var(--color-vi) ${60 - i * 10}%, transparent))`,
                }}
                title={`${s.label}: layers ${s.layerStart}–${s.layerEnd - 1}`}
              >
                {s.layerEnd - s.layerStart}
              </div>
            ))}
          </div>
          <div className="mt-2 space-y-1">
            {option.partition.stages.map((s, i) => (
              <div key={s.deviceId + i} className="flex items-center gap-2 text-[11.5px] text-mute">
                <span className="flex-1 truncate">
                  {s.label} · layers {s.layerStart}–{s.layerEnd - 1}
                  {s.hasEmbedding && ' · embedding'}
                  {s.hasLmHead && ' · output projection'}
                </span>
                <span className="tabular-nums">{bytes(s.weightBytes + s.kvBytes)}</span>
                <span className="w-14 text-right tabular-nums">{s.msPerToken.toFixed(1)} ms</span>
              </div>
            ))}
            {option.partition.networkOverheadMs > 0 && (
              <div className="flex items-center gap-2 border-t border-line pt-1 text-[11.5px] text-amber/80">
                <span className="flex-1">Network hops between stages</span>
                <span className="w-14 text-right tabular-nums">
                  {option.partition.networkOverheadMs.toFixed(1)} ms
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {option.caveats.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {option.caveats.map((c) => (
            <li key={c} className="flex gap-2 text-[12.5px] leading-relaxed text-amber/85">
              <TriangleAlert size={12} className="mt-[3px] shrink-0" />
              {c}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ── Target solver ────────────────────────────────────────────────────── */

function TargetSolver() {
  const members = useFleetMembers()
  const models = useSpecs()
  const [modelId, setModelId] = useState<string | null>(null)
  const [target, setTarget] = useState(30)

  const model = models.find((m) => m.spec.id === modelId)?.spec ?? models[0]?.spec
  const draft = models.find((m) => m.spec.params < 1.2e9)?.spec

  const result = useMemo(
    () =>
      model
        ? optionsMeetingTarget(model, target, members.map((m) => m.cap), { ctx: 2048, draft })
        : null,
    [model, target, members, draft],
  )

  if (!model) return <p className="text-[13.5px] text-mute">Reading model architectures…</p>

  const shown = result?.meeting.length ? result.meeting : result?.closest ? [result.closest] : []

  return (
    <div>
      <div className="flex flex-wrap items-end gap-6">
        <label className="block">
          <span className="text-[10.5px] tracking-wide text-mute uppercase">Model</span>
          <select
            value={model.id}
            onChange={(e) => setModelId(e.target.value)}
            className="mt-1.5 block h-10 rounded-[9px] border border-line-bright bg-panel/60 px-3 text-[13.5px] outline-none focus:border-cy/50"
          >
            {models.map((m) => (
              <option key={m.spec.id} value={m.spec.id}>
                {m.spec.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block min-w-[260px] flex-1">
          <span className="text-[10.5px] tracking-wide text-mute uppercase">
            Target speed — <span className="text-cy">{target} tok/s</span>
          </span>
          <input
            type="range"
            min={5}
            max={150}
            step={5}
            value={target}
            onChange={(e) => setTarget(Number(e.target.value))}
            className="mt-3 block w-full accent-[var(--color-cy)]"
          />
          <span className="mt-1 block text-[11.5px] text-mute">
            Around 15 tok/s reads comfortably; 40+ feels instant.
          </span>
        </label>
      </div>

      <div className="mt-8">
        {result?.meeting.length ? (
          <SectionHead
            title={`${result.meeting.length} way${result.meeting.length > 1 ? 's' : ''} to reach ${target} tok/s`}
            note="Cheapest change first — what you already own always wins."
          />
        ) : (
          <SectionHead
            title={`Nothing here reaches ${target} tok/s on ${model.label}`}
            note="This is the closest you can get. Dropping to a smaller model is usually the better trade."
          />
        )}

        <motion.div
          className="mt-4 space-y-2"
          initial="hidden"
          animate="show"
          variants={stagger(0, 0.05)}
        >
          {shown.map((o) => (
            <motion.div key={o.id} variants={riseIn}>
              <TargetOptionCard option={o} model={model} target={target} />
            </motion.div>
          ))}
        </motion.div>
      </div>
    </div>
  )
}

function TargetOptionCard({
  option, model, target,
}: {
  option: FleetOption
  model: ModelSpec
  target: number
}) {
  const [open, setOpen] = useState(false)
  const meets = option.tokensPerSec >= target

  return (
    <Spotlight className="panel rounded-md" tint={meets ? 'var(--color-cy)' : 'var(--color-amber)'}>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-4 px-4 py-4 text-left">
        <div className="flex shrink-0 -space-x-1.5">
          {option.devices.flatMap((d) =>
            Array.from({ length: Math.min(d.count, 4) }, (_, i) => {
              const Icon = KIND_ICON[d.spec.kind]
              return (
                <span
                  key={`${d.spec.id}-${i}`}
                  className={cn(
                    'grid h-7 w-7 place-items-center rounded-full border bg-panel',
                    d.owned ? 'border-cy/40 text-cy' : 'border-line-bright text-mute',
                  )}
                >
                  <Icon size={12} />
                </span>
              )
            }),
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium">{option.headline}</span>
            {option.usesOnlyOwned && <Chip tone="good">you own this</Chip>}
            {option.kind === 'speculative' && (
              <Chip tone="live" icon={<Zap size={10} />}>
                speculative
              </Chip>
            )}
            {option.kind === 'pipeline' && <Chip tone="warn">split across devices</Chip>}
          </div>
          <div className="mt-1 line-clamp-1 text-[12.5px] text-mute">{option.why}</div>
        </div>

        <div className="shrink-0 text-right">
          <div
            className={cn(
              'text-[19px] leading-none font-semibold',
              meets ? 'text-gradient' : 'text-amber',
            )}
          >
            <NumberTicker value={option.tokensPerSec} decimals={0} />
            <span className="ml-1 text-[11px] font-normal text-mute">tok/s</span>
          </div>
          <div className="mt-1 text-[10.5px] text-mute">first token {ms(option.ttftMs)}</div>
        </div>

        <ChevronRight size={15} className={cn('shrink-0 text-mute transition-transform', open && 'rotate-90')} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring.soft}
            className="overflow-hidden"
          >
            <div className="border-t border-line px-4 py-4">
              <OptionDetail option={option} model={model} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Spotlight>
  )
}
