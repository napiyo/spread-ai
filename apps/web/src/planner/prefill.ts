import type { Capability } from '@/capability/identify'
import { DEFAULT_PREFILL_EFF } from './roofline'
import { activeParams, kvBytesPerToken, type ModelSpec } from './modelSpec'
import { DEFAULT_LINK_GBS } from './migrate'

/**
 * Reading one long prompt on several devices at once.
 *
 * Prefill and decode are opposites, and treating them as one workload is why
 * "spread the model out" keeps getting the wrong answer:
 *
 *   Decode is memory-bandwidth bound and strictly sequential. Token n+1 needs
 *   token n. No arrangement of devices shortens it.
 *
 *   Prefill is compute bound and the prompt is already all there. The work is
 *   divisible. Two devices really can halve it.
 *
 * So the honest place to spend a fleet is time-to-first-token on a long input,
 * which is also the delay a person actually feels when they paste a document.
 *
 * The catch, and the reason this needs a cost model rather than an opinion:
 * every block of the prompt has to attend to every earlier block, so the
 * devices must exchange KV as they go — context parallelism, a ring exchange —
 * and then the winner has to gather all of it before it can decode. That is
 * real bytes over a real link. Whether it pays is arithmetic, and the arithmetic
 * has a surprise in it. See `prefillRatio`.
 */

const DEFAULT_HOP_MS = 2.5

export interface PrefillDevice {
  cap: Capability
  /** Only a device holding this model can read part of the prompt. */
  hasModelLoaded: boolean
  hopMs?: number
  linkGBs?: number
}

export interface PrefillInput {
  model: ModelSpec
  /** The device that will decode, and so must end up holding the whole KV. */
  decodeOn: Capability
  helpers: PrefillDevice[]
  promptTokens: number
  linkGBs?: number
  hopMs?: number
}

export interface PrefillPlan {
  worthwhile: boolean
  /** Devices that would take part, decode device first. */
  devices: Capability[]
  /** Tokens each one reads, in the same order. */
  chunks: number[]
  baselineTtftMs: number
  parallelTtftMs: number
  savedMs: number
  /** Ring exchange plus the final gather onto the decode device. */
  transferMs: number
  /** Shortest prompt for which this arrangement wins at all. */
  crossoverTokens: number
  why: string
  caveats: string[]
}

/* ── The structural result ────────────────────────────────────────────── */

/**
 * Cost of moving the KV, as a fraction of the compute a split saves.
 *
 * Both scale linearly with prompt length, so **this ratio does not depend on
 * how long the prompt is.** Whether parallel prefill is worth doing is a
 * property of the model and the link, not of the input — which is not what you
 * would guess, and is the single most useful thing this file computes. A
 * grouped-query model over a room-speed link sits well under 1 and is worth
 * splitting at any length past the fixed overheads; a multi-head model with a
 * fat KV cache can sit above 1 and is never worth splitting, however long the
 * prompt gets.
 *
 * Below 1 means the transfer costs less than the compute it saves.
 */
export function prefillRatio(
  model: ModelSpec,
  cap: Capability,
  linkGBs = DEFAULT_LINK_GBS,
): number {
  const flopsPerSec = cap.gflopsF16 * 1e9 * (cap.calibration?.prefillEff ?? DEFAULT_PREFILL_EFF)
  const secondsPerTokenOfCompute = (2 * activeParams(model)) / flopsPerSec
  const secondsPerTokenOfTransfer = kvBytesPerToken(model) / (linkGBs * 1e9)
  return secondsPerTokenOfTransfer / Math.max(1e-12, secondsPerTokenOfCompute)
}

/** Bytes that cross the link to prefill `tokens` across `parts` devices. */
export function prefillTransferBytes(model: ModelSpec, tokens: number, parts: number): number {
  if (parts < 2) return 0
  const kv = kvBytesPerToken(model) * tokens
  // Ring exchange: each device forwards its block to every other, so the busiest
  // link carries (parts-1)/parts of the whole KV.
  const ring = kv * ((parts - 1) / parts)
  // Then everything has to end up wherever decoding happens.
  const gather = kv * ((parts - 1) / parts)
  return ring + gather
}

/* ── The plan ─────────────────────────────────────────────────────────── */

export function planParallelPrefill(i: PrefillInput): PrefillPlan {
  const hopMs = i.hopMs ?? DEFAULT_HOP_MS
  const linkGBs = i.linkGBs ?? DEFAULT_LINK_GBS

  const helpers = i.helpers.filter(
    (h) => h.hasModelLoaded && h.cap.hasWebGpu && h.cap.deviceId !== i.decodeOn.deviceId,
  )
  const fleet = [i.decodeOn, ...helpers.map((h) => h.cap)]
  const baselineTtftMs = prefillMs(i.model, i.decodeOn, i.promptTokens)

  const no = (why: string, caveats: string[] = []): PrefillPlan => ({
    worthwhile: false,
    devices: [i.decodeOn],
    chunks: [i.promptTokens],
    baselineTtftMs,
    parallelTtftMs: baselineTtftMs,
    savedMs: 0,
    transferMs: 0,
    crossoverTokens: Infinity,
    why,
    caveats,
  })

  if (fleet.length < 2) {
    return no('Nothing else here is holding this model, so the whole prompt is read on one device.')
  }

  const ratio = prefillRatio(i.model, i.decodeOn, linkGBs)
  if (ratio >= 1) {
    return no(
      `Moving this model's KV cache costs more than the reading it saves — ${ratio.toFixed(2)}x — so splitting the prompt is slower at any length. ${describeKv(i.model)}`,
      ['A faster link between the devices is the only thing that changes this. More devices makes it worse, not better.'],
    )
  }

  // Chunks proportional to compute, so nobody waits on the slowest device
  // holding an equal share it cannot get through.
  const power = fleet.map((c) => c.gflopsF16 * (c.calibration?.prefillEff ?? DEFAULT_PREFILL_EFF))
  const total = power.reduce((a, b) => a + b, 0)
  const chunks = power.map((p) => Math.round((p / total) * i.promptTokens))
  chunks[0] += i.promptTokens - chunks.reduce((a, b) => a + b, 0)

  // Everyone works at once, so the compute cost is the slowest share, not the sum.
  const computeMs = Math.max(
    ...fleet.map((c, n) => prefillMs(i.model, c, chunks[n], i.promptTokens)),
  )
  const transferMs =
    (prefillTransferBytes(i.model, i.promptTokens, fleet.length) / (linkGBs * 1e9)) * 1000 +
    2 * hopMs * (fleet.length - 1)

  const parallelTtftMs = computeMs + transferMs
  const savedMs = baselineTtftMs - parallelTtftMs

  // Found by asking the same model about shorter prompts rather than by a
  // closed form. Attention is quadratic, so the baseline grows faster than the
  // transfer does and the honest crossover is not a ratio of two lines.
  const crossoverTokens = shortestWorthwhile(i, fleet, linkGBs, hopMs)

  if (savedMs <= 0) {
    return no(
      `At ${i.promptTokens.toLocaleString()} tokens the split is not yet ahead; it starts paying at about ${Number.isFinite(crossoverTokens) ? crossoverTokens.toLocaleString() : 'no'} tokens.`,
      [`Transfer alone costs ${Math.round(transferMs)} ms here.`],
    )
  }

  return {
    worthwhile: true,
    devices: fleet,
    chunks,
    baselineTtftMs,
    parallelTtftMs,
    savedMs,
    transferMs,
    crossoverTokens,
    why: `${fleet.length} devices read ${i.promptTokens.toLocaleString()} tokens between them — ${chunks.map((c, n) => `${c.toLocaleString()} on ${fleet[n].label}`).join(', ')} — and the first token arrives about ${(savedMs / 1000).toFixed(1)}s sooner. Prefill is compute-bound and the prompt is all there at once, so this genuinely divides.`,
    caveats: [
      `${Math.round(transferMs)} ms of that is KV crossing the link: every block has to attend to every earlier one, and the decoding device has to end up with all of it.`,
      `Only worth it past about ${Number.isFinite(crossoverTokens) ? crossoverTokens.toLocaleString() : '∞'} tokens; below that the round trips dominate.`,
      'Decoding is untouched. This shortens the wait for the first token, not the speed of the rest.',
    ],
  }
}

/* ── helpers ──────────────────────────────────────────────────────────── */

/**
 * Time to prefill `tokens` of a prompt whose full length is `ofTotal`.
 *
 * The MLP work is linear in the device's own share. Attention is not: a block
 * has to attend to everything before it, so its cost depends on where in the
 * sequence it sits. Charging every device the average keeps the split honest
 * without pretending the last block is as cheap as the first.
 */
function prefillMs(model: ModelSpec, cap: Capability, tokens: number, ofTotal = tokens): number {
  const flopsPerSec = cap.gflopsF16 * 1e9 * (cap.calibration?.prefillEff ?? DEFAULT_PREFILL_EFF)
  const mlp = 2 * activeParams(model) * tokens
  // QK^T and AV, both hiddenSize-wide, over the whole context the block sees.
  const attn = 4 * model.nLayers * model.hiddenSize * tokens * ofTotal
  return ((mlp + attn) / Math.max(1, flopsPerSec)) * 1000
}

/**
 * The shortest prompt this fleet is still ahead on.
 *
 * Bisection over the real cost model. `savedMs` is monotonic in prompt length
 * once the ratio is below 1 — the compute saved grows at least linearly while
 * the transfer grows exactly linearly — so a bisection lands on the true
 * crossover rather than on a linearisation of it.
 */
function shortestWorthwhile(
  i: PrefillInput,
  fleet: Capability[],
  linkGBs: number,
  hopMs: number,
): number {
  const saved = (tokens: number) => {
    const power = fleet.map((c) => c.gflopsF16 * (c.calibration?.prefillEff ?? DEFAULT_PREFILL_EFF))
    const total = power.reduce((a, b) => a + b, 0)
    const compute = Math.max(
      ...fleet.map((c, n) => prefillMs(i.model, c, Math.round((power[n] / total) * tokens), tokens)),
    )
    const transfer =
      (prefillTransferBytes(i.model, tokens, fleet.length) / (linkGBs * 1e9)) * 1000 +
      2 * hopMs * (fleet.length - 1)
    return prefillMs(i.model, i.decodeOn, tokens) - (compute + transfer)
  }

  if (saved(1) > 0) return 1
  let hi = 1
  while (hi < 1e6 && saved(hi) <= 0) hi *= 2
  if (saved(hi) <= 0) return Infinity

  let lo = hi / 2
  for (let n = 0; n < 40; n++) {
    const mid = Math.floor((lo + hi) / 2)
    if (saved(mid) > 0) hi = mid
    else lo = mid
  }
  return hi
}

function describeKv(model: ModelSpec): string {
  const mha = model.nKvHeads >= model.nHeads
  return mha
    ? `${model.label} uses full multi-head attention, so its KV cache is ${model.nHeads / Math.max(1, model.nKvHeads)}x heavier than a grouped-query model of the same size.`
    : `${model.label} already uses grouped-query attention; the link is what is too slow here, not the model.`
}
