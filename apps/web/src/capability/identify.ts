import { DEVICE_DB, type DeviceSpec } from './deviceDb'
import type { BenchResult } from './bench'
import type { DeviceProbe } from './types'
import type { ThermalProfile } from '@/planner/thermal'

/**
 * The single record the planner consumes and the mesh gossips. Every field
 * carries how we know it, because a measured 219 GB/s and a guessed 273 GB/s
 * should never be presented to the user as the same kind of fact.
 */
export interface Capability {
  deviceId: string
  /** User-editable display name. */
  label: string
  kind: DeviceSpec['kind']

  hasWebGpu: boolean
  webgpuUnavailableReason: string | null
  hasF16: boolean

  /** Effective (not nominal) read bandwidth, GB/s. */
  bandwidthGBs: number
  /** Effective fp16 matmul throughput, GFLOP/s. */
  gflopsF16: number
  /** Hard ceiling on one WebGPU allocation. The thing that decides fit. */
  maxBufferBytes: number
  /** Bytes of *memory* available for weights + KV on this device. */
  weightBudgetBytes: number
  /**
   * Bytes the browser will let us persist. Weights are cached to disk so they
   * survive a reload and work offline, so this is a hard limit on model size
   * too — but a completely different limit from memory, with a different fix
   * (free up disk, rather than close tabs).
   */
  storageBudgetBytes: number

  source: 'measured' | 'matched' | 'assumed'
  match: { spec: DeviceSpec; confidence: number } | null
  probe: DeviceProbe | null
  bench: BenchResult | null
  /** Recalibrated from real generations. See planner/roofline. */
  calibration: { decodeEff: number; prefillEff: number; samples: number } | null
  /**
   * How this device holds up under sustained load. Absent until a long enough
   * run has been watched, at which point the planner stops using the prior for
   * its class — see planner/thermal.
   */
  thermal?: ThermalProfile
}

const GB = 1024 ** 3

/**
 * Two different efficiencies live in this app and conflating them produces
 * confidently wrong answers, so they are named apart:
 *
 *   NOMINAL_TO_BENCH_BW  - what our pure streaming-read kernel achieves against
 *     the spec sheet. Sequential reads on unified memory get close to peak, and
 *     measurements on Apple Silicon land around 0.9. Used to *recognise* a
 *     device and to project one we have never seen.
 *
 *   DECODE_EFF (planner/roofline) - what a real decode loop achieves against
 *     our *measured* bandwidth. Much lower, because dequantisation and mixed
 *     access patterns are nothing like a sequential sweep.
 */
const NOMINAL_TO_BENCH_BW = 0.9
/** Our portable tiled matmul reaches roughly this share of advertised peak. */
const NOMINAL_TO_BENCH_FLOPS = 0.28

function gate(probe: DeviceProbe, spec: DeviceSpec): boolean {
  const p = probe.platform
  const apple = p.appleFamily
  const isAppleChip = /^M\d|^A\d/.test(spec.chip)

  if (apple === 'iphone') return spec.kind === 'phone' && spec.chip.startsWith('A')
  if (apple === 'ipad') return spec.kind === 'tablet'
  if (apple === 'mac') return (spec.kind === 'laptop' || spec.kind === 'desktop') && spec.chip.startsWith('M')
  if (p.os === 'Android') return spec.kind === 'phone' && !isAppleChip
  // Windows / Linux / unknown: anything non-Apple.
  return !isAppleChip
}

/** 1 at a perfect match, decaying to 0 as the values diverge. */
function closeness(a: number, b: number, tolerance: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return 0
  return Math.max(0, 1 - Math.abs(a - b) / (b * tolerance))
}

/**
 * Names the device in front of us. Bandwidth is by far the strongest signal —
 * it separates an M4 Pro from an M3 Pro where core counts and RAM do not.
 */
export function identify(
  probe: DeviceProbe,
  bench: BenchResult | null,
): { spec: DeviceSpec; confidence: number } | null {
  const candidates = DEVICE_DB.filter((s) => gate(probe, s))
  if (!candidates.length) return null

  const scored = candidates.map((spec) => {
    let score = 0
    let weight = 0

    if (bench) {
      // A device can never exceed its own nominal bandwidth, so a measured
      // value above spec rules the candidate out rather than merely scoring low.
      const ratio = bench.bandwidthGBs / spec.bandwidthGBs
      const bwScore = ratio > 1.02 ? 0 : closeness(ratio, NOMINAL_TO_BENCH_BW, 0.35)
      score += bwScore * 5
      weight += 5

      if (bench.gflopsF16) {
        const fRatio = bench.gflopsF16 / spec.gflopsF16
        score += (fRatio > 1.02 ? 0 : closeness(fRatio, NOMINAL_TO_BENCH_FLOPS, 1.0)) * 2
        weight += 2
      }
    }

    const mem = probe.platform.deviceMemoryGb
    if (mem != null) {
      // navigator.deviceMemory is quantised and clamped for privacy, so it is
      // a weak lower bound rather than a reading.
      score += closeness(mem, Math.min(spec.memGb, 8), 0.6) * 1
      weight += 1
    }

    if (probe.webgpu?.maxBufferSize) {
      const mb = probe.webgpu.maxBufferSize / (1024 * 1024)
      score += closeness(Math.min(mb, 4096), spec.webgpuMaxBufferMb, 0.8) * 1
      weight += 1
    }

    return { spec, confidence: weight ? score / weight : 0 }
  })

  scored.sort((a, b) => b.confidence - a.confidence)
  const best = scored[0]
  return best.confidence > 0.25 ? best : null
}

/** Turns a probe (+ optional benchmark) into the record everything else uses. */
export function toCapability(
  probe: DeviceProbe,
  bench: BenchResult | null,
  overrides: Partial<Pick<Capability, 'label'>> = {},
): Capability {
  const match = identify(probe, bench)
  const spec = match?.spec

  const bandwidthGBs = bench
    ? bench.bandwidthGBs
    : spec
      ? spec.bandwidthGBs * NOMINAL_TO_BENCH_BW
      : 25 // deliberately pessimistic when we know nothing

  const gflopsF16 = bench
    ? (bench.gflopsF16 ?? bench.gflopsF32)
    : spec
      ? spec.gflopsF16 * NOMINAL_TO_BENCH_FLOPS
      : 500

  // The adapter's own limit beats any table. Fall back to the table only for
  // devices we are projecting rather than standing in front of.
  const maxBufferBytes =
    probe.webgpu?.maxBufferSize || (spec ? spec.webgpuMaxBufferMb * 1024 * 1024 : 256 * 1024 * 1024)

  const memBytes = (probe.platform.deviceMemoryGb ?? spec?.memGb ?? 4) * GB
  const fraction = spec?.usableMemFraction ?? (probe.platform.mobile ? 0.28 : 0.5)
  const weightBudgetBytes = memBytes * fraction
  // Leave headroom: a quota that is exactly full evicts rather than erroring.
  const storageBudgetBytes = (probe.storage.quotaBytes ?? Infinity) * 0.85

  return {
    deviceId: probe.id,
    label: overrides.label ?? spec?.label ?? describeUnknown(probe),
    kind: spec?.kind ?? (probe.platform.mobile ? 'phone' : 'laptop'),
    hasWebGpu: Boolean(probe.webgpu),
    webgpuUnavailableReason: probe.webgpuUnavailableReason,
    hasF16: probe.webgpu?.hasF16 ?? false,
    bandwidthGBs,
    gflopsF16,
    maxBufferBytes,
    weightBudgetBytes,
    storageBudgetBytes,
    source: bench ? 'measured' : match ? 'matched' : 'assumed',
    match,
    probe,
    bench,
    calibration: null,
  }
}

function describeUnknown(probe: DeviceProbe): string {
  const p = probe.platform
  if (p.model) return p.model
  const os = p.os === 'Unknown' ? 'Device' : p.os
  return `${os} · ${p.browser}`
}

/** Projects a device from the table alone — used for devices you don't have yet. */
export function capabilityFromSpec(spec: DeviceSpec, instance = 0): Capability {
  return {
    deviceId: `spec:${spec.id}:${instance}`,
    label: spec.label,
    kind: spec.kind,
    hasWebGpu: true,
    webgpuUnavailableReason: null,
    hasF16: true,
    bandwidthGBs: spec.bandwidthGBs * NOMINAL_TO_BENCH_BW,
    gflopsF16: spec.gflopsF16 * NOMINAL_TO_BENCH_FLOPS,
    maxBufferBytes: spec.webgpuMaxBufferMb * 1024 * 1024,
    weightBudgetBytes: spec.memGb * GB * spec.usableMemFraction,
    // Projected devices are assumed to have disk to spare; only the machine we
    // are standing on has a quota we can actually read.
    storageBudgetBytes: Infinity,
    source: 'assumed',
    match: { spec, confidence: 1 },
    probe: null,
    bench: null,
    calibration: null,
  }
}
