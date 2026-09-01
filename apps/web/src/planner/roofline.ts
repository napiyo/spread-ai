import type { Capability } from '@/capability/identify'
import {
  activeParams, byteBudget, footprintBytes, kvBytesPerToken, type ModelSpec,
} from './modelSpec'

/**
 * A roofline model of in-browser LLM inference.
 *
 *   Decode is memory-bandwidth bound. Every token streams the active weights
 *   plus the whole KV cache through the memory system, and arithmetic intensity
 *   is ~1 op/byte, so time = bytes / bandwidth. Nothing else matters much.
 *
 *   Prefill is compute bound. The prompt is processed as one big matmul batch,
 *   so time = FLOPs / throughput.
 *
 * The two efficiency constants below are priors. The moment a real generation
 * completes we solve for the true value on that device and store it — see
 * `calibrate`. After that, projections for *other* devices ride on a constant
 * measured on hardware we actually observed rather than on a guess.
 */

/**
 * Share of measured streaming bandwidth a real decode loop achieves.
 *
 * Much lower than a sequential sweep, because decode reads a quantised weight
 * matrix and dequantises it, walks a scattered KV cache, and does it all in
 * hundreds of small dispatches. Anchored to published WebLLM figures: an 8B
 * 4-bit model at ~30 tok/s on a ~360 GB/s machine implies ~0.35, and the same
 * constant then reproduces observed speeds for 1B and 0.6B models too.
 */
export const DEFAULT_DECODE_EFF = 0.35

/**
 * Fixed cost per token that has nothing to do with bandwidth.
 *
 * Each transformer layer issues a handful of separate WebGPU dispatches, and
 * each dispatch costs tens of microseconds of command-encoding and scheduling
 * regardless of how little work it does. Without this term the model predicts
 * 500 tok/s for a 0.6B model, when the real ceiling in a browser is nearer 150
 * — small models are latency-bound, not bandwidth-bound, and the roofline has
 * to say so.
 *
 * Fitted against three measurements rather than guessed: SmolLM2 360M at ~103
 * tok/s and Llama 3.2 1B at ~90 tok/s (both measured in this app on an M4 Pro),
 * and published WebLLM figures for 8B models. A smaller value made the two
 * small models imply an efficiency less than half the one the 8B implied, which
 * is the signature of overhead being misattributed to bandwidth.
 */
export const DISPATCH_MS_PER_LAYER = 0.22
/**
 * Real prefill kernels are better tuned than our portable benchmark matmul, so
 * they exceed it. Expressed as a multiple of the *measured* bench number.
 */
export const DEFAULT_PREFILL_EFF = 1.8

export interface Estimate {
  tokensPerSec: number
  ttftMs: number
  /** Time to finish a whole response of `outputTokens`. */
  totalMs: number
  /** True when this rests on a calibration measured on this device. */
  calibrated: boolean
}

export interface EstimateInput {
  model: ModelSpec
  cap: Capability
  /** Context length to price the KV cache at. */
  ctx: number
  promptTokens: number
  outputTokens: number
}

export function estimate(i: EstimateInput): Estimate {
  const b = byteBudget(i.model)
  const decodeEff = i.cap.calibration?.decodeEff ?? DEFAULT_DECODE_EFF
  const prefillEff = i.cap.calibration?.prefillEff ?? DEFAULT_PREFILL_EFF

  // KV grows through the response, so price it at the midpoint rather than at
  // either end — using the start flatters short contexts and the end punishes
  // them.
  const avgCtx = i.ctx + i.outputTokens / 2
  const bytesPerToken = b.activeWeightBytes + kvBytesPerToken(i.model) * avgCtx
  const bwBytesPerSec = i.cap.bandwidthGBs * 1e9 * decodeEff
  const bandwidthMs = (bytesPerToken / bwBytesPerSec) * 1000
  const overheadMs = DISPATCH_MS_PER_LAYER * i.model.nLayers
  const tokensPerSec = 1000 / Math.max(0.01, bandwidthMs + overheadMs)

  const flops = 2 * activeParams(i.model) * Math.max(1, i.promptTokens)
  const flopsPerSec = i.cap.gflopsF16 * 1e9 * prefillEff
  const ttftMs = (flops / flopsPerSec) * 1000

  return {
    tokensPerSec,
    ttftMs,
    totalMs: ttftMs + (i.outputTokens / Math.max(0.01, tokensPerSec)) * 1000,
    calibrated: Boolean(i.cap.calibration),
  }
}

/**
 * Solves for the efficiency constants implied by a generation that really ran.
 *
 * Returns the previous calibration untouched when a sample cannot be trusted.
 * Clamping a bad reading into range and then averaging it in is worse than
 * discarding it: it looks like a measurement and poisons every later estimate.
 * The first run after a load is the classic offender — it carries shader
 * compilation and reads roughly half speed — so callers must not pass it here.
 */
export function calibrate(
  model: ModelSpec,
  cap: Capability,
  observed: { tokensPerSec: number; ttftMs: number; promptTokens: number; ctx: number },
): Capability['calibration'] {
  const prev = cap.calibration
  const b = byteBudget(model)

  /* Decode. */
  const bytesPerToken = b.activeWeightBytes + kvBytesPerToken(model) * observed.ctx
  const msPerToken = 1000 / Math.max(0.01, observed.tokensPerSec)
  const bandwidthMs = msPerToken - DISPATCH_MS_PER_LAYER * model.nLayers
  const decodeEff =
    bandwidthMs > 0.05 ? bytesPerToken / (bandwidthMs / 1000) / (cap.bandwidthGBs * 1e9) : NaN

  /* Prefill. Only meaningful once the prompt is long enough that compute, and
     not fixed per-request overhead, dominates the time to first token. */
  const flops = 2 * activeParams(model) * observed.promptTokens
  const prefillEff =
    observed.promptTokens >= 32 && observed.ttftMs > 1
      ? flops / (observed.ttftMs / 1000) / (cap.gflopsF16 * 1e9)
      : NaN

  const decodeOk = Number.isFinite(decodeEff) && decodeEff > 0.05 && decodeEff < 1.2
  const prefillOk = Number.isFinite(prefillEff) && prefillEff > 0.2 && prefillEff < 8

  if (!decodeOk && !prefillOk) return prev ?? null

  const n = (prev?.samples ?? 0) + (decodeOk ? 1 : 0)
  // Running mean, so later models and prompt shapes nudge the constant rather
  // than replacing it wholesale.
  const mean = (old: number | undefined, next: number, count: number) =>
    old == null ? next : old + (next - old) / Math.max(1, count)

  return {
    decodeEff: decodeOk
      ? mean(prev?.decodeEff, decodeEff, n)
      : (prev?.decodeEff ?? DEFAULT_DECODE_EFF),
    prefillEff: prefillOk
      ? mean(prev?.prefillEff, prefillEff, n)
      : (prev?.prefillEff ?? DEFAULT_PREFILL_EFF),
    samples: n,
  }
}

/* ── Fit ──────────────────────────────────────────────────────────────── */

export interface FitResult {
  fits: boolean
  /** Ordered worst-first, user-facing. */
  blockers: string[]
  warnings: string[]
  requiredBytes: number
  headroomBytes: number
}

export function fitsOnDevice(model: ModelSpec, cap: Capability, ctx: number): FitResult {
  const b = byteBudget(model)
  const required = footprintBytes(model, ctx)
  const blockers: string[] = []
  const warnings: string[] = []

  if (!cap.hasWebGpu) {
    blockers.push(cap.webgpuUnavailableReason ?? 'This device has no WebGPU.')
  }

  if (required > cap.weightBudgetBytes) {
    blockers.push(
      `Needs ${gb(required)} of memory but only about ${gb(cap.weightBudgetBytes)} is available to a browser tab here.`,
    )
  }

  // Weights are cached to disk so they survive a reload and work offline, so a
  // small storage quota blocks a model just as firmly as a small GPU — and the
  // fix is different, so it must not be reported as a memory problem.
  if (byteBudget(model).totalWeightBytes > cap.storageBudgetBytes) {
    blockers.push(
      `Its ${gb(byteBudget(model).totalWeightBytes)} of weights won't fit in this browser's ${gb(cap.storageBudgetBytes)} storage quota. Freeing up disk space raises it.`,
    )
  }

  if (b.largestTensorBytes > cap.maxBufferBytes) {
    // Worth distinguishing: many runtimes chunk the output projection, so this
    // is often survivable. Saying "impossible" when it is merely likely would
    // be the wrong call.
    const msg = `Its largest single tensor is ${gb(b.largestTensorBytes)}, above this device's ${gb(cap.maxBufferBytes)} WebGPU buffer limit.`
    if (b.largestTensorBytes > cap.maxBufferBytes * 2) blockers.push(msg)
    else warnings.push(`${msg} Some runtimes split it and get away with this; expect it to be fragile.`)
  }

  if (ctx > model.maxContext) {
    warnings.push(`Asked for ${ctx.toLocaleString()} tokens of context but the model was trained for ${model.maxContext.toLocaleString()}.`)
  }

  if (!cap.hasF16 && model.quant.includes('f16')) {
    warnings.push('No shader-f16 on this GPU, so fp16 weights are unpacked to fp32 and use twice the memory.')
  }

  return {
    fits: blockers.length === 0,
    blockers,
    warnings,
    requiredBytes: required,
    headroomBytes: cap.weightBudgetBytes - required,
  }
}

function gb(n: number): string {
  const g = n / 1024 ** 3
  return g >= 1 ? `${g.toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(0)} MB`
}
