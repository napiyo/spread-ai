import { useEffect, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  Activity, ArrowRight, Cpu, Gauge, HardDrive, Layers, MemoryStick, ShieldCheck, Zap,
} from 'lucide-react'
import { Aurora } from '@/ui/fx/Aurora'
import { GridField } from '@/ui/fx/GridField'
import { TextGenerate } from '@/ui/fx/TextGenerate'
import { Spotlight } from '@/ui/fx/Spotlight'
import { Button } from '@/ui/primitives/Button'
import { Chip, LiveDot } from '@/ui/primitives/Chip'
import { Stat } from '@/ui/primitives/Stat'
import { useDevice } from '@/store/device'
import { bytes } from '@/lib/format'
import { riseIn, spring, stagger } from '@/lib/motion'
import { navigate } from '@/lib/router'

export function Landing() {
  const { probe, bench, capability, benching, benchPhase, benchProgress, error, init, benchmark } =
    useDevice()

  useEffect(() => {
    void init()
  }, [init])

  return (
    <div className="relative min-h-dvh overflow-hidden">
      <Aurora />
      <GridField />

      <main className="relative mx-auto max-w-6xl px-6 pt-20 pb-28 sm:pt-28">
        <motion.div initial="hidden" animate="show" variants={stagger(0, 0.08)}>
          <motion.div variants={riseIn}>
            <Chip tone="live" icon={<LiveDot tone="var(--color-cy)" />}>
              zero install · webgpu · works offline
            </Chip>
          </motion.div>

          <h1 className="mt-7 text-[clamp(2.5rem,7.5vw,5.2rem)] leading-[0.94] font-semibold tracking-[-0.035em] text-balance">
            <TextGenerate text="Run language models" />
            <br />
            <TextGenerate text="in a browser tab." className="text-gradient" delay={0.35} gradient />
          </h1>

          <motion.p
            variants={riseIn}
            className="mt-7 max-w-2xl text-[17px] leading-relaxed text-dim text-pretty"
          >
            Weights download once and run on your GPU through WebGPU. Nothing is installed, no
            prompt leaves the device, and every device you own can join in — your laptop carrying
            the heavy layers while a phone helps out. Open the same link anywhere; your
            conversations follow you, online or not.
          </motion.p>

          <motion.div variants={riseIn} className="mt-9 flex flex-wrap items-center gap-3">
            <Button variant="primary" size="lg" onClick={() => navigate('models')}>
              Pick a model <ArrowRight size={16} />
            </Button>
            <Button variant="outline" size="lg" onClick={() => navigate('advisor')}>
              <Layers size={16} /> What can my devices run?
            </Button>
          </motion.div>
        </motion.div>

        <ProbeStrip />

        <div className="mt-14">
          <BenchPanel
            probe={probe}
            bench={bench}
            capability={capability}
            benching={benching}
            benchPhase={benchPhase}
            benchProgress={benchProgress}
            error={error}
            onRun={benchmark}
          />
        </div>

        <Promises />
      </main>
    </div>
  )
}

/* ── Capability chips ─────────────────────────────────────────────────── */

interface ChipItem {
  key: string
  tone: 'good' | 'bad' | 'warn' | 'neutral'
  icon: ReactNode
  text: string
}

function ProbeStrip() {
  const { probe } = useDevice()

  const items = probe
    ? [
        probe.webgpu
          ? {
              key: 'gpu',
              tone: 'good' as const,
              icon: <Zap size={12} />,
              text: `WebGPU · ${probe.webgpu.vendor || 'gpu'}${probe.webgpu.architecture ? ` ${probe.webgpu.architecture}` : ''}`,
            }
          : {
              key: 'gpu',
              tone: 'bad' as const,
              icon: <Zap size={12} />,
              text: 'No WebGPU on this browser',
            },
        probe.webgpu?.hasF16 && {
          key: 'f16',
          tone: 'good' as const,
          icon: <Cpu size={12} />,
          text: 'fp16 shaders',
        },
        probe.platform.cores && {
          key: 'cores',
          tone: 'neutral' as const,
          icon: <Cpu size={12} />,
          text: `${probe.platform.cores} cores`,
        },
        probe.platform.deviceMemoryGb && {
          key: 'mem',
          tone: 'neutral' as const,
          icon: <MemoryStick size={12} />,
          text: `${probe.platform.deviceMemoryGb} GB memory`,
        },
        probe.storage.quotaBytes && {
          key: 'quota',
          tone: 'neutral' as const,
          icon: <HardDrive size={12} />,
          text: `${bytes(probe.storage.quotaBytes)} cache quota`,
        },
        probe.webgpu && {
          key: 'buf',
          tone: (probe.webgpu.maxBufferSize < 512 * 1024 ** 2 ? 'warn' : 'neutral') as
            | 'warn'
            | 'neutral',
          icon: <Layers size={12} />,
          text: `${bytes(probe.webgpu.maxBufferSize, 0)} max buffer`,
        },
      ].filter(Boolean)
    : []

  return (
    <motion.div
      className="mt-12 flex min-h-8 flex-wrap items-center gap-2"
      initial="hidden"
      animate="show"
      variants={stagger(0.15, 0.07)}
    >
      <AnimatePresence>
        {(items as ChipItem[]).map(
          (it) => (
            <motion.span
              key={it.key}
              variants={riseIn}
              layout
              exit={{ opacity: 0, scale: 0.9 }}
              transition={spring.quick}
            >
              <Chip tone={it.tone} icon={it.icon}>
                {it.text}
              </Chip>
            </motion.span>
          ),
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/* ── Benchmark ────────────────────────────────────────────────────────── */

const PHASE_COPY: Record<string, string> = {
  init: 'Opening a GPU device',
  bandwidth: 'Streaming memory',
  'matmul-f32': 'Multiplying matrices (fp32)',
  'matmul-f16': 'Multiplying matrices (fp16)',
  done: 'Done',
}

function BenchPanel({
  probe, bench, capability, benching, benchPhase, benchProgress, error, onRun,
}: {
  probe: ReturnType<typeof useDevice.getState>['probe']
  bench: ReturnType<typeof useDevice.getState>['bench']
  capability: ReturnType<typeof useDevice.getState>['capability']
  benching: boolean
  benchPhase: string | null
  benchProgress: number
  error: string | null
  onRun: () => void
}) {
  const still = useReducedMotion()

  if (probe && !probe.webgpu) {
    return (
      <Spotlight className="rounded-lg panel" tint="var(--color-rose)">
        <div className="p-6">
          <div className="flex items-center gap-2 text-rose">
            <Zap size={15} />
            <span className="text-sm font-medium">This browser can't run models</span>
          </div>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-dim">
            {probe.webgpuUnavailableReason}
          </p>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-mute">
            You can still use this device to plan a fleet, sync conversations, and drive a model
            running on another device you own.
          </p>
        </div>
      </Spotlight>
    )
  }

  return (
    <Spotlight className="panel rounded-lg">
      <div className="p-6 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-medium tracking-[0.14em] text-mute uppercase">
              <Gauge size={13} /> This device
            </div>
            <div className="mt-2 text-xl font-semibold tracking-tight">
              {capability?.label ?? 'Identifying…'}
            </div>
            <div className="mt-1 text-[13px] text-mute">
              {capability?.match && bench
                ? `Matched against its measured bandwidth · ${Math.round(capability.match.confidence * 100)}% confidence`
                : capability?.match
                  ? `A guess from what the browser will admit to · ${Math.round(capability.match.confidence * 100)}% confidence. Benchmark it to know.`
                  : bench
                    ? "Measured, but it matches nothing in our table — the numbers below are still real."
                    : 'Run the benchmark to identify it properly.'}
            </div>
          </div>

          {!bench && !benching && (
            <Button variant="primary" onClick={onRun}>
              <Activity size={15} /> Benchmark this device
            </Button>
          )}
          {bench && !benching && (
            <Button variant="ghost" size="sm" onClick={onRun}>
              Re-run
            </Button>
          )}
        </div>

        <AnimatePresence mode="wait">
          {benching && (
            <motion.div
              key="running"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={spring.soft}
              className="overflow-hidden"
            >
              <div className="mt-6 flex items-center gap-3">
                <LiveDot tone="var(--color-cy)" />
                <span className="text-sm text-dim">
                  {PHASE_COPY[benchPhase ?? 'init'] ?? 'Working'}…
                </span>
              </div>
              <div className="mt-3 h-[3px] overflow-hidden rounded-full bg-line">
                <motion.div
                  className="h-full rounded-full"
                  style={{ background: 'linear-gradient(90deg, var(--color-cy), var(--color-vi))' }}
                  animate={{ width: `${Math.max(6, benchProgress * 100)}%` }}
                  transition={still ? { duration: 0 } : spring.soft}
                />
              </div>
            </motion.div>
          )}

          {bench && !benching && (
            <motion.div
              key="results"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={spring.soft}
            >
              <div className="mt-7 grid grid-cols-2 gap-6 border-t border-line pt-6 sm:grid-cols-4">
                <Stat
                  label="Memory bandwidth"
                  value={bench.bandwidthGBs}
                  unit="GB/s"
                  decimals={0}
                  source="measured"
                  hint="Decoding is bound by this. It is the single number that predicts tokens per second."
                />
                <Stat
                  label={bench.gflopsF16 ? 'fp16 throughput' : 'fp32 throughput'}
                  value={(bench.gflopsF16 ?? bench.gflopsF32) / 1000}
                  unit="TFLOP/s"
                  decimals={2}
                  source="measured"
                  hint="Prompt processing is bound by this. It sets how long you wait for the first token."
                />
                <Stat
                  label="Largest allocation"
                  value={bytes(bench.allocatedBytes, 0)}
                  source="measured"
                  hint="The biggest single GPU buffer this device actually handed us."
                />
                <Stat
                  label="Benchmark took"
                  value={Math.round(bench.elapsedMs)}
                  unit="ms"
                  source="measured"
                />
              </div>

              {bench.warnings.length > 0 && (
                <ul className="mt-5 space-y-1.5">
                  {bench.warnings.map((w) => (
                    <li key={w} className="flex gap-2 text-[13px] leading-relaxed text-amber/90">
                      <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-amber" />
                      {w}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-6 flex flex-wrap gap-3">
                <Button onClick={() => navigate('advisor')}>
                  See what this can run <ArrowRight size={15} />
                </Button>
                <Button variant="ghost" onClick={() => navigate('fleet')}>
                  Add another device
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {!bench && !benching && (
          <p className="mt-5 max-w-xl text-[13px] leading-relaxed text-mute">
            Two short GPU kernels — one streams memory, one multiplies matrices. Under a second of
            work, and it runs only when you ask. Everything the advisor tells you afterwards is
            derived from these two numbers rather than from a guess about your hardware.
          </p>
        )}

        {error && <p className="mt-4 text-[13px] text-rose">{error}</p>}
      </div>
    </Spotlight>
  )
}

/* ── Value props ──────────────────────────────────────────────────────── */

const PROMISES = [
  {
    icon: ShieldCheck,
    title: 'Nothing leaves the device',
    body: 'Prompts, tokens and weights stay in the tab. The only server involved introduces devices to each other and never sees what they say.',
  },
  {
    icon: Layers,
    title: 'Devices add capacity, not speed',
    body: "Splitting one model across phones makes it runnable, not faster — stages run in sequence. Where extra devices genuinely do make things quicker, we'll say which trick is doing it.",
  },
  {
    icon: HardDrive,
    title: 'Offline after the first load',
    body: 'Weights are cached, conversations are CRDTs. Go offline mid-sentence, pick it up on another device, merge without losing a word.',
  },
]

function Promises() {
  return (
    <motion.div
      className="mt-24 grid gap-4 sm:grid-cols-3"
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '-80px' }}
      variants={stagger(0, 0.09)}
    >
      {PROMISES.map((p) => (
        <motion.div key={p.title} variants={riseIn}>
          <Spotlight className="h-full rounded-lg panel">
            <div className="p-5">
              <p.icon size={17} className="text-cy" />
              <h3 className="mt-3 text-[15px] font-medium tracking-tight">{p.title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-mute">{p.body}</p>
            </div>
          </Spotlight>
        </motion.div>
      ))}
    </motion.div>
  )
}
