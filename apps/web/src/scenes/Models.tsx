import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle, ArrowRight, Check, Download, Link2, Loader2, Search, Sparkles, X, Zap,
} from 'lucide-react'
import { GridField } from '@/ui/fx/GridField'
import { Spotlight } from '@/ui/fx/Spotlight'
import { NumberTicker } from '@/ui/fx/NumberTicker'
import { Button } from '@/ui/primitives/Button'
import { Chip } from '@/ui/primitives/Chip'
import { useCatalog, toLoadable } from '@/store/catalog'
import { useDevice } from '@/store/device'
import { useEngine } from '@/store/engine'
import { usePrediction, type Prediction } from '@/planner/usePrediction'
import { searchModels, type HfSearchResult } from '@/catalog/hf'
import type { CatalogEntry } from '@/catalog/types'
import { bytes, compact, ms } from '@/lib/format'
import { riseIn, spring, stagger } from '@/lib/motion'
import { navigate } from '@/lib/router'
import { cn } from '@/lib/cn'

type Tab = 'featured' | 'search' | 'link'

export function Models() {
  const [tab, setTab] = useState<Tab>('featured')
  const init = useCatalog((s) => s.init)
  const deviceInit = useDevice((s) => s.init)

  useEffect(() => {
    init()
    void deviceInit()
  }, [init, deviceInit])

  return (
    <div className="relative min-h-dvh">
      <GridField fade="top" className="opacity-60" />
      <div className="relative mx-auto max-w-6xl px-6 py-14">
        <h1 className="text-[34px] leading-tight font-semibold tracking-[-0.03em]">Choose a model</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-dim">
          Featured models are pre-compiled and start fastest. Anything else on Hugging Face works
          too, as long as somebody has exported it to ONNX — we'll tell you either way, and why.
        </p>

        <div className="mt-7 flex gap-1 border-b border-line">
          {(
            [
              ['featured', 'Featured', Sparkles],
              ['search', 'Search Hugging Face', Search],
              ['link', 'Paste a link', Link2],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                'relative flex items-center gap-2 px-3 pb-3 text-[13.5px] transition-colors',
                tab === id ? 'text-fore' : 'text-mute hover:text-dim',
              )}
            >
              <Icon size={14} />
              {label}
              {tab === id && (
                <motion.span
                  layoutId="models-tab"
                  className="absolute right-0 -bottom-px left-0 h-px bg-cy"
                  transition={spring.quick}
                />
              )}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className="mt-8"
          >
            {tab === 'featured' && <FeaturedGrid />}
            {tab === 'search' && <SearchPanel />}
            {tab === 'link' && <LinkPanel />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

/* ── Featured ─────────────────────────────────────────────────────────── */

function FeaturedGrid() {
  const featured = useCatalog((s) => s.featured)
  const cap = useDevice((s) => s.capability)

  // Runnable first. Nobody wants to scroll past four models their laptop
  // cannot load to find the one it can.
  const sorted = useMemo(() => [...featured].sort((a, b) => a.paramsB - b.paramsB), [featured])

  return (
    <>
      {cap && !cap.bench && (
        <div className="mb-5 flex items-center gap-3 rounded-md border border-amber/25 bg-amber/[0.05] px-4 py-3 text-[13px] text-amber/90">
          <AlertTriangle size={15} className="shrink-0" />
          <span>
            These speeds assume a {cap.label}. Benchmark the device and they become measurements.
          </span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => navigate('home')}>
            Benchmark
          </Button>
        </div>
      )}
      <motion.div
        className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
        initial="hidden"
        animate="show"
        variants={stagger(0, 0.05)}
      >
        {sorted.map((e) => (
          <motion.div key={e.id} variants={riseIn}>
            <ModelCard entry={e} />
          </motion.div>
        ))}
      </motion.div>
    </>
  )
}

function ModelCard({ entry }: { entry: CatalogEntry }) {
  const prediction = usePrediction(entry.id, entry.contextWindow, entry.vramMb)
  const spec = useCatalog((s) => s.specs[entry.id])
  const { load, model, status } = useEngine()
  const isCurrent = model?.id === entry.id

  return (
    <Spotlight
      className={cn(
        'panel flex h-full flex-col rounded-lg transition-colors',
        prediction && !prediction.fits && 'opacity-60',
      )}
      tint={prediction?.fits === false ? 'var(--color-rose)' : 'var(--color-vi)'}
    >
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-[15.5px] font-medium tracking-tight">{entry.label}</h3>
            <div className="mt-0.5 text-[12px] text-mute">
              {entry.paramsB < 1
                ? `${Math.round(entry.paramsB * 1000)}M`
                : `${entry.paramsB}B`}{' '}
              params · {entry.quant.startsWith('q4') ? '4-bit' : entry.quant} ·{' '}
              {compact(entry.contextWindow)} ctx
            </div>
          </div>
          <FitBadge prediction={prediction} />
        </div>

        <p className="mt-3 flex-1 text-[13px] leading-relaxed text-dim">{entry.blurb}</p>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {entry.tags.map((t) => (
            <Chip key={t}>{t}</Chip>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-4">
          <MiniStat
            label="Download"
            value={entry.vramMb ? bytes(entry.vramMb * 1024 ** 2, 1) : '—'}
          />
          <MiniStat
            label="Speed"
            hint={
              prediction?.calibrated
                ? 'Based on efficiency measured during a real generation on this device.'
                : 'Estimated at 1K tokens of context. Long conversations run slower, because every token re-reads the whole cache.'
            }
            value={
              prediction?.tokensPerSec != null ? (
                <>
                  <NumberTicker value={prediction.tokensPerSec} decimals={0} />
                  <span className="ml-1 text-[11px] text-mute">tok/s</span>
                </>
              ) : (
                '—'
              )
            }
            accent={prediction?.calibrated}
          />
          <MiniStat
            label="First token"
            hint="Time to the first token for a 256-token prompt."
            value={prediction?.ttftMs != null ? ms(prediction.ttftMs) : '—'}
          />
        </div>

        {prediction && !prediction.fits && prediction.blockers[0] && (
          <p className="mt-3 text-[12px] leading-relaxed text-rose/85">{prediction.blockers[0]}</p>
        )}
        {prediction?.fits && prediction.warnings[0] && (
          <p className="mt-3 text-[12px] leading-relaxed text-amber/85">{prediction.warnings[0]}</p>
        )}

        <div className="mt-4 flex items-center gap-2">
          <Button
            variant={isCurrent ? 'outline' : 'primary'}
            size="sm"
            className="flex-1"
            disabled={status === 'loading' || (prediction ? !prediction.fits : false)}
            onClick={async () => {
              await load(toLoadable(entry, spec))
              navigate('chat')
            }}
          >
            {isCurrent && status === 'ready' ? (
              <>
                <Check size={14} /> Loaded
              </>
            ) : status === 'loading' && isCurrent ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Loading
              </>
            ) : (
              <>
                <Download size={14} /> Load
              </>
            )}
          </Button>
        </div>
      </div>
    </Spotlight>
  )
}

function MiniStat({
  label,
  value,
  accent,
  hint,
}: {
  label: string
  value: React.ReactNode
  accent?: boolean
  hint?: string
}) {
  return (
    <div title={hint}>
      <div className="text-[10px] tracking-wide text-mute uppercase">{label}</div>
      <div
        className={cn(
          'mt-0.5 flex items-baseline text-[14px] font-medium',
          accent ? 'text-gradient' : 'text-fore',
        )}
      >
        {value}
      </div>
    </div>
  )
}

function FitBadge({ prediction }: { prediction: Prediction | null }) {
  if (!prediction) return <Chip>checking…</Chip>
  if (!prediction.fits) return <Chip tone="bad">won't fit</Chip>
  if (prediction.warnings.length) return <Chip tone="warn">tight</Chip>
  return (
    <Chip tone="good" icon={<Zap size={11} />}>
      {prediction.exact ? 'fits' : 'likely fits'}
    </Chip>
  )
}

/* ── Search ───────────────────────────────────────────────────────────── */

function SearchPanel() {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<HfSearchResult[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const resolve = useCatalog((s) => s.resolve)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      setRows([])
      setErr(null)
      return
    }
    // Debounced, and the previous request is cancelled so results can never
    // arrive out of order behind a faster one.
    const t = setTimeout(() => {
      abort.current?.abort()
      const ac = new AbortController()
      abort.current = ac
      setBusy(true)
      setErr(null)
      searchModels(term, { signal: ac.signal, limit: 24 })
        .then((r) => setRows(r))
        .catch((e) => {
          if (e.name !== 'AbortError') setErr(String(e.message ?? e))
        })
        .finally(() => setBusy(false))
    }, 260)
    return () => clearTimeout(t)
  }, [q])

  return (
    <div>
      <div className="relative">
        <Search size={15} className="absolute top-1/2 left-3.5 -translate-y-1/2 text-mute" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search text-generation models — try “qwen3 onnx” or “smollm”"
          className="h-11 w-full rounded-[10px] border border-line-bright bg-panel/60 pr-4 pl-10 text-[14px] outline-none placeholder:text-mute focus:border-cy/50"
        />
        {busy && (
          <Loader2 size={15} className="absolute top-1/2 right-3.5 -translate-y-1/2 animate-spin text-mute" />
        )}
      </div>

      <p className="mt-3 text-[12.5px] text-mute">
        Repos tagged <span className="font-mono text-dim">transformers.js</span> or{' '}
        <span className="font-mono text-dim">onnx</span> are the ones that load. Others get checked
        properly when you open them.
      </p>

      {err && <p className="mt-4 text-[13px] text-rose">{err}</p>}

      <div className="mt-5 divide-y divide-line overflow-hidden rounded-lg border border-line">
        {rows.map((r) => (
          <button
            key={r.id}
            onClick={() => resolve(r.id)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-panel/60"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px]">{r.id}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-mute">
                <span>{compact(r.downloads)} downloads</span>
                {r.library && <span className="font-mono">{r.library}</span>}
              </div>
            </div>
            {(r.library === 'transformers.js' || r.tags.includes('onnx')) && (
              <Chip tone="good">onnx</Chip>
            )}
            {r.library === 'mlc-llm' && <Chip tone="live">mlc</Chip>}
            <ArrowRight size={14} className="shrink-0 text-mute" />
          </button>
        ))}
        {!rows.length && !busy && q.trim().length >= 2 && (
          <div className="px-4 py-8 text-center text-[13px] text-mute">Nothing matched.</div>
        )}
      </div>

      <ResolutionSheet />
    </div>
  )
}

/* ── Paste a link ─────────────────────────────────────────────────────── */

function LinkPanel() {
  const [value, setValue] = useState('')
  const { resolve, resolving } = useCatalog()

  const submit = () => {
    if (value.trim()) void resolve(value)
  }

  return (
    <div className="max-w-3xl">
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX"
          className="h-11 flex-1 rounded-[10px] border border-line-bright bg-panel/60 px-4 font-mono text-[13px] outline-none placeholder:text-mute focus:border-cy/50"
        />
        <Button variant="primary" onClick={submit} disabled={resolving}>
          {resolving ? <Loader2 size={15} className="animate-spin" /> : 'Check'}
        </Button>
      </div>

      <p className="mt-3 text-[12.5px] leading-relaxed text-mute">
        Any model repo, or just <span className="font-mono text-dim">owner/name</span>. We read the
        file list and tell you exactly what can be done with it — including when the answer is
        nothing, and why.
      </p>

      <ResolutionSheet />
    </div>
  )
}

/* ── Verdict ──────────────────────────────────────────────────────────── */

const VERDICT_TONE = {
  mlc: 'good',
  onnx: 'good',
  shardable: 'warn',
  unsupported: 'bad',
} as const

const VERDICT_LABEL = {
  mlc: 'Ready to run',
  onnx: 'Ready to run',
  shardable: 'Needs conversion first',
  unsupported: "Can't run in a browser",
} as const

function ResolutionSheet() {
  const { resolution, resolving, resolveError, clearResolution } = useCatalog()
  const prediction = usePrediction(
    resolution?.repo ?? '',
    resolution?.spec?.maxContext ?? 4096,
    resolution?.downloadBytes ? resolution.downloadBytes / 1024 ** 2 : null,
  )
  const { load, status } = useEngine()

  if (resolveError) {
    return <p className="mt-6 text-[13px] text-rose">{resolveError}</p>
  }
  if (!resolution && !resolving) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={spring.soft}
        className="mt-6"
      >
        {resolving && (
          <div className="flex items-center gap-2 text-[13px] text-mute">
            <Loader2 size={14} className="animate-spin" /> Reading the repository…
          </div>
        )}

        {resolution && (
          <Spotlight
            className="panel rounded-lg"
            tint={resolution.verdict === 'unsupported' ? 'var(--color-rose)' : 'var(--color-cy)'}
          >
            <div className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Chip tone={VERDICT_TONE[resolution.verdict]}>
                      {VERDICT_LABEL[resolution.verdict]}
                    </Chip>
                    {resolution.info?.downloads != null && (
                      <span className="text-[11.5px] text-mute">
                        {compact(resolution.info.downloads)} downloads
                      </span>
                    )}
                  </div>
                  <h3 className="mt-3 font-mono text-[15px] break-all">{resolution.repo}</h3>
                </div>
                <button onClick={clearResolution} className="text-mute hover:text-fore">
                  <X size={16} />
                </button>
              </div>

              <p className="mt-3 text-[13.5px] leading-relaxed text-dim">{resolution.reason}</p>
              {resolution.hint && (
                <p className="mt-2 text-[13px] leading-relaxed text-mute">{resolution.hint}</p>
              )}

              {resolution.variants.length > 1 && (
                <div className="mt-4">
                  <div className="text-[10.5px] tracking-wide text-mute uppercase">
                    Precisions available
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {resolution.variants.map((v) => (
                      <Chip key={v.dtype} tone={v.dtype === 'q4f16' ? 'live' : 'neutral'}>
                        {v.label} · {bytes(v.bytes)}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}

              {resolution.spec && (
                <div className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-4">
                  <MiniStat label="Layers" value={resolution.spec.nLayers} />
                  <MiniStat label="Hidden size" value={compact(resolution.spec.hiddenSize)} />
                  <MiniStat
                    label="KV heads"
                    value={`${resolution.spec.nKvHeads} of ${resolution.spec.nHeads}`}
                  />
                  <MiniStat
                    label="Speed here"
                    value={
                      prediction?.tokensPerSec != null
                        ? `${Math.round(prediction.tokensPerSec)} tok/s`
                        : '—'
                    }
                    accent={prediction?.calibrated}
                  />
                </div>
              )}

              {prediction && !prediction.fits && prediction.blockers[0] && (
                <p className="mt-4 text-[13px] text-rose/90">{prediction.blockers[0]}</p>
              )}

              {resolution.loadable && (
                <Button
                  variant="primary"
                  className="mt-5"
                  disabled={status === 'loading' || prediction?.fits === false}
                  onClick={async () => {
                    await load(resolution.loadable!)
                    navigate('chat')
                  }}
                >
                  <Download size={15} /> Load this model
                </Button>
              )}
            </div>
          </Spotlight>
        )}
      </motion.div>
    </AnimatePresence>
  )
}
